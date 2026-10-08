import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import { getPrisma } from '@cdn/database';
import { ALL_QUEUES, getQueue } from './queue.js';
import { getRedis } from './redis.js';

/**
 * Prometheus metrics for GET /metrics. Request metrics are recorded by hooks in app.ts; queue,
 * database, Redis, storage and webhook gauges are collected at scrape time.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'cdn_' });

export const httpDuration = new Histogram({
  name: 'cdn_http_request_duration_seconds',
  help: 'HTTP request duration by route',
  labelNames: ['method', 'route', 'status', 'kind'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const bytesSent = new Counter({
  name: 'cdn_delivery_bytes_total',
  help: 'Bytes delivered by kind (delivery, transform, media, share)',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const activeTransfers = new Gauge({
  name: 'cdn_active_transfers',
  help: 'In-flight delivery responses and uploads in this process',
  labelNames: ['direction'] as const,
  registers: [registry],
});

export const cacheStatusTotal = new Counter({
  name: 'cdn_cache_status_total',
  help: 'Origin cache outcomes (origin, revalidated, range, variant-hit, variant-miss, redirect)',
  labelNames: ['status'] as const,
  registers: [registry],
});

const queueJobs = new Gauge({ name: 'cdn_queue_jobs', help: 'Background jobs by queue and state', labelNames: ['queue', 'state'] as const, registers: [registry] });
const dependencyUp = new Gauge({ name: 'cdn_dependency_up', help: '1 when a dependency answered the probe', labelNames: ['dependency'] as const, registers: [registry] });
const dependencyLatency = new Gauge({ name: 'cdn_dependency_latency_seconds', help: 'Probe latency of dependencies', labelNames: ['dependency'] as const, registers: [registry] });
const storageHealth = new Gauge({ name: 'cdn_storage_provider_healthy', help: 'Storage provider health (last periodic check)', labelNames: ['provider', 'kind', 'region'] as const, registers: [registry] });
const storageLatency = new Gauge({ name: 'cdn_storage_provider_latency_seconds', help: 'Storage provider health-check latency', labelNames: ['provider'] as const, registers: [registry] });
const webhookBacklog = new Gauge({ name: 'cdn_webhook_backlog', help: 'Webhook deliveries pending or failed', labelNames: ['status'] as const, registers: [registry] });
const malware = new Gauge({ name: 'cdn_quarantined_files', help: 'Files quarantined by the malware scanner', registers: [registry] });
const workerHeartbeat = new Gauge({ name: 'cdn_worker_heartbeat_age_seconds', help: 'Seconds since the worker last reported in', registers: [registry] });
const filesTotal = new Gauge({ name: 'cdn_files', help: 'Files by status', labelNames: ['status'] as const, registers: [registry] });

async function timed<T>(fn: () => Promise<T>): Promise<number | null> {
  const started = process.hrtime.bigint();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    return Number(process.hrtime.bigint() - started) / 1e9;
  } catch {
    return null;
  }
}

export async function collectScrapeMetrics(): Promise<void> {
  const prisma = getPrisma();
  const [db, redis] = await Promise.all([timed(() => prisma.$queryRaw`SELECT 1`), timed(() => getRedis().ping())]);
  for (const [name, v] of [['postgres', db], ['redis', redis]] as const) {
    dependencyUp.set({ dependency: name }, v === null ? 0 : 1);
    if (v !== null) dependencyLatency.set({ dependency: name }, v);
  }
  if (redis !== null) {
    await Promise.all(
      ALL_QUEUES.map(async (q) => {
        const counts = await getQueue(q).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
        for (const [state, n] of Object.entries(counts)) queueJobs.set({ queue: q, state }, n);
      }),
    );
    const hb = await getRedis().get('worker:heartbeat');
    workerHeartbeat.set(hb ? (Date.now() - Number(hb)) / 1000 : 1e9);
  }
  if (db !== null) {
    const [providers, hooks, quarantined, files] = await Promise.all([
      prisma.storageProvider.findMany({ select: { name: true, kind: true, region: true, healthStatus: true, latencyMs: true } }),
      prisma.webhookDelivery.groupBy({ by: ['status'], _count: true, where: { status: { in: ['PENDING', 'FAILED'] } } }),
      prisma.file.count({ where: { status: 'QUARANTINED' } }),
      prisma.file.groupBy({ by: ['status'], _count: true }),
    ]);
    for (const p of providers) {
      storageHealth.set({ provider: p.name, kind: p.kind, region: p.region }, p.healthStatus === 'unhealthy' ? 0 : 1);
      if (p.latencyMs !== null) storageLatency.set({ provider: p.name }, p.latencyMs / 1000);
    }
    webhookBacklog.reset();
    for (const h of hooks) webhookBacklog.set({ status: h.status.toLowerCase() }, h._count);
    malware.set(quarantined);
    filesTotal.reset();
    for (const f of files) filesTotal.set({ status: f.status.toLowerCase() }, f._count);
  }
}
