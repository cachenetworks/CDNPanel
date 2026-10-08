import { z } from 'zod';
import type { Job } from 'bullmq';
import { getPrisma, Prisma } from '@cdn/database';
import { AppError, safeEqual } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { env } from '../config/env.js';
import { audit, sanitizeMetadata } from '../lib/audit.js';
import { isPrivateIp } from '../lib/ip.js';
import { collectScrapeMetrics, registry } from '../lib/metrics.js';
import { ALL_QUEUES, getQueue, type QueueName } from '../lib/queue.js';
import { getRedis } from '../lib/redis.js';
import { resolveRange } from '../services/analytics.js';
import { inspectUrl } from '../services/inspector.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? 0 : Number(v));
const JOB_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed', 'paused'] as const;
const queueParam = z.object({ name: z.enum(ALL_QUEUES as [QueueName, ...QueueName[]]) });

function serializeJob(job: Job, state?: string) {
  return {
    id: job.id,
    name: job.name,
    state: state ?? null,
    data: sanitizeMetadata(job.data),
    attempts_made: job.attemptsMade,
    attempts: job.opts.attempts ?? 1,
    failed_reason: job.failedReason ?? null,
    stacktrace: (job.stacktrace ?? []).slice(-1)[0]?.split('\n').slice(0, 12).join('\n') ?? null,
    progress: job.progress,
    created_at: new Date(job.timestamp).toISOString(),
    processed_at: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finished_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    duration_ms: job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null,
  };
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number | null }> {
  const t = process.hrtime.bigint();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    return { ok: true, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10 };
  } catch {
    return { ok: false, ms: null };
  }
}

export const opsRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/metrics',
    tag: 'Operations',
    summary: 'Prometheus metrics',
    description: 'OpenMetrics / Prometheus exposition. Requires `Authorization: Bearer <METRICS_TOKEN>` when METRICS_TOKEN is set; otherwise only reachable from private networks (e.g. a Prometheus container on the compose network).',
    auth: 'public',
    responses: { 200: { description: 'Metrics', contentType: 'text/plain' } },
    async handler({ req, reply }) {
      const token = env().METRICS_TOKEN;
      const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (token ? !presented || !safeEqual(presented, token) : !isPrivateIp(req.clientIp)) throw new AppError('not_found');
      await collectScrapeMetrics();
      reply.header('Content-Type', registry.contentType).header('Cache-Control', 'no-store');
      return registry.metrics();
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/ops/overview',
    tag: 'Operations',
    summary: 'Operations overview',
    description: 'Latency percentiles, throughput, dependency health, storage latency, queue depth, jobs per minute, webhook backlog, malware scanning and worker heartbeat.',
    auth: 'session',
    permission: 'ops.view',
    async handler() {
      const prisma = getPrisma();
      const since = new Date(Date.now() - 3_600_000);
      const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
      const [latency, perMinute, db, redis, providers, webhooks, quarantined, failedFiles, heartbeat, scansFailed] = await Promise.all([
        prisma.$queryRaw<Row[]>`
          SELECT "kind",
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY "responseMs") AS p50,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseMs") AS p95,
                 percentile_cont(0.99) WITHIN GROUP (ORDER BY "responseMs") AS p99,
                 count(*) AS requests, count(*) FILTER (WHERE "statusCode" >= 500) AS errors_5xx
          FROM "FileRequest" WHERE "timestamp" >= ${utc(since)} GROUP BY 1`,
        prisma.$queryRaw<Row[]>`
          SELECT date_trunc('minute', "timestamp") AS t, count(*) AS requests, coalesce(sum("bytesSent"), 0) AS bytes,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseMs") AS p95
          FROM "FileRequest" WHERE "timestamp" >= ${utc(since)} GROUP BY 1 ORDER BY 1`,
        timed(() => prisma.$queryRaw`SELECT 1`),
        timed(() => getRedis().ping()),
        prisma.storageProvider.findMany({ select: { id: true, name: true, kind: true, region: true, healthStatus: true, latencyMs: true, healthCheckedAt: true, enabled: true } }),
        prisma.webhookDelivery.groupBy({ by: ['status'], _count: true, where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
        prisma.file.count({ where: { status: 'QUARANTINED' } }),
        prisma.file.count({ where: { status: 'FAILED' } }),
        getRedis().get('worker:heartbeat').catch(() => null),
        prisma.file.count({ where: { status: 'FAILED', statusReason: { contains: 'scan', mode: 'insensitive' } } }),
      ]);
      const queues = await Promise.all(
        ALL_QUEUES.map(async (name) => {
          const q = getQueue(name);
          const [counts, completed, failed, paused] = await Promise.all([
            q.getJobCounts(...JOB_STATES),
            q.getMetrics('completed', 0, 60).catch(() => null),
            q.getMetrics('failed', 0, 60).catch(() => null),
            q.isPaused(),
          ]);
          const perMin = (m: { data: number[] } | null) => (m && m.data.length ? Math.round((m.data.reduce((a, b) => a + b, 0) / m.data.length) * 10) / 10 : 0);
          return { name, counts, paused, completed_per_minute: perMin(completed), failed_per_minute: perMin(failed) };
        }),
      );
      const hbAge = heartbeat ? Math.round((Date.now() - Number(heartbeat)) / 1000) : null;
      return {
        latency: latency.map((r) => ({ kind: String(r.kind), p50_ms: Math.round(num(r.p50)), p95_ms: Math.round(num(r.p95)), p99_ms: Math.round(num(r.p99)), requests: num(r.requests), errors_5xx: num(r.errors_5xx) })),
        per_minute: perMinute.map((r) => ({ t: (r.t as Date).toISOString(), requests: num(r.requests), bytes: num(r.bytes), p95_ms: Math.round(num(r.p95)) })),
        dependencies: { postgres: db, redis },
        storage: providers.map((p) => ({ ...p, healthCheckedAt: p.healthCheckedAt?.toISOString() ?? null })),
        queues,
        webhooks: Object.fromEntries(webhooks.map((w) => [w.status.toLowerCase(), w._count])),
        files: { quarantined, failed: failedFiles, scan_failures: scansFailed },
        worker: { heartbeat_age_seconds: hbAge, healthy: hbAge !== null && hbAge < 90 },
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/ops/queues/:name/jobs',
    tag: 'Operations',
    summary: 'List background jobs',
    auth: 'session',
    permission: 'ops.view',
    params: queueParam,
    query: z.object({ state: z.enum(JOB_STATES).default('failed'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }),
    async handler({ params, query }) {
      const q = getQueue(params.name);
      const start = (query.page - 1) * query.limit;
      const [jobs, counts] = await Promise.all([q.getJobs([query.state], start, start + query.limit - 1, query.state !== 'completed'), q.getJobCounts(query.state)]);
      const total = counts[query.state] ?? 0;
      return {
        data: jobs.filter(Boolean).map((j) => serializeJob(j, query.state)),
        pagination: { page: query.page, limit: query.limit, total, total_pages: Math.max(1, Math.ceil(total / query.limit)), has_more: start + query.limit < total },
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/ops/queues/:name/jobs/:id',
    tag: 'Operations',
    summary: 'Inspect a job',
    auth: 'session',
    permission: 'ops.view',
    params: queueParam.extend({ id: z.string().max(200) }),
    errors: ['not_found'],
    async handler({ params }) {
      const job = await getQueue(params.name).getJob(params.id);
      if (!job) throw new AppError('not_found');
      const state = await job.getState();
      return { ...serializeJob(job, state), stacktrace_full: job.stacktrace ?? [], logs: (await getQueue(params.name).getJobLogs(params.id, 0, 50)).logs, return_value: sanitizeMetadata(job.returnvalue) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/ops/queues/:name/jobs/:id/retry',
    tag: 'Operations',
    summary: 'Retry a failed job',
    auth: 'session',
    permission: 'ops.manage',
    params: queueParam.extend({ id: z.string().max(200) }),
    errors: ['not_found', 'conflict'],
    async handler({ req, params }) {
      const job = await getQueue(params.name).getJob(params.id);
      if (!job) throw new AppError('not_found');
      if ((await job.getState()) !== 'failed') throw new AppError('conflict', 'Only failed jobs can be retried.');
      await job.retry('failed');
      await audit(actorOf(req), 'JOB_RETRIED', { type: 'job', id: `${params.name}:${params.id}` }, { name: job.name });
      return { retried: true };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/ops/queues/:name/jobs/:id',
    tag: 'Operations',
    summary: 'Remove a job',
    auth: 'session',
    permission: 'ops.manage',
    params: queueParam.extend({ id: z.string().max(200) }),
    errors: ['not_found', 'conflict'],
    async handler({ req, params }) {
      const job = await getQueue(params.name).getJob(params.id);
      if (!job) throw new AppError('not_found');
      if ((await job.getState()) === 'active') throw new AppError('conflict', 'Active jobs cannot be removed.');
      await job.remove();
      await audit(actorOf(req), 'JOB_REMOVED', { type: 'job', id: `${params.name}:${params.id}` }, { name: job.name });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/ops/queues/:name/retry-failed',
    tag: 'Operations',
    summary: 'Retry every failed job in a queue',
    auth: 'session',
    permission: 'ops.manage',
    params: queueParam,
    async handler({ req, params }) {
      const q = getQueue(params.name);
      const failed = await q.getJobCounts('failed');
      await q.retryJobs({ state: 'failed', count: 1000 });
      await audit(actorOf(req), 'JOB_RETRIED', { type: 'queue', id: params.name }, { count: failed.failed });
      return { retried: failed.failed ?? 0 };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/ops/queues/:name/clean',
    tag: 'Operations',
    summary: 'Clean finished jobs',
    auth: 'session',
    permission: 'ops.manage',
    params: queueParam,
    body: z.object({ state: z.enum(['completed', 'failed']), older_than_hours: z.number().int().min(0).max(24 * 365).default(24) }),
    async handler({ req, params, body }) {
      const removed = await getQueue(params.name).clean(body.older_than_hours * 3_600_000, 10_000, body.state);
      await audit(actorOf(req), 'JOB_REMOVED', { type: 'queue', id: params.name }, { state: body.state, removed: removed.length });
      return { removed: removed.length };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/ops/queues/:name/:action',
    tag: 'Operations',
    summary: 'Pause or resume a queue',
    auth: 'session',
    permission: 'ops.manage',
    params: queueParam.extend({ action: z.enum(['pause', 'resume']) }),
    async handler({ req, params }) {
      const q = getQueue(params.name);
      if (params.action === 'pause') await q.pause();
      else await q.resume();
      await audit(actorOf(req), 'JOB_RETRIED', { type: 'queue', id: params.name }, { action: params.action });
      return { paused: await q.isPaused() };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/ops/inspect',
    tag: 'Operations',
    summary: 'Asset Inspector',
    description:
      'Explains exactly how a CDN URL is handled: host and zone matching, file resolution, edge security (for the given visitor country / referer), authorization, image transformation and signature, storage source and failover order, cache policy (edge / browser TTL, rule, tags), content handling and predicted response headers. With `live: true` the URL is also fetched through the edge and real headers and timing are returned.',
    auth: 'session',
    permission: 'files.view',
    body: z.object({
      url: z.string().url().max(4000),
      country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
      referer: z.string().max(2000).optional(),
      authenticated: z.boolean().default(false),
      live: z.boolean().default(false),
    }),
    rateLimit: { name: 'inspect', max: 60, windowSeconds: 60 },
    async handler({ body }) {
      return inspectUrl(body);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/analytics/geo',
    tag: 'Analytics',
    summary: 'Global delivery map data',
    description: 'Requests, bandwidth and origin cache-hit ratio per visitor country, plus flows from storage origins (by provider region / served countries) to countries.',
    auth: 'any',
    permission: 'analytics.view',
    scope: 'analytics:read',
    query: z.object({ period: z.enum(['24h', '7d', '30d']).default('24h'), zone_id: z.string().optional() }),
    async handler({ query }) {
      const range = resolveRange(query.period);
      const prisma = getPrisma();
      const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
      const zoneFilter = query.zone_id ? Prisma.sql`AND r."zoneId" = ${query.zone_id}` : Prisma.empty;
      const [countries, flows, providers] = await Promise.all([
        prisma.$queryRaw<Row[]>`
          SELECT coalesce(r."country", 'XX') AS country, count(*) AS requests, coalesce(sum(r."bytesSent"), 0) AS bytes,
                 count(*) FILTER (WHERE r."cacheStatus" IN ('revalidated', 'variant-hit')) AS hits,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY r."responseMs") AS p50
          FROM "FileRequest" r WHERE r."kind" <> 'api' AND r."timestamp" >= ${utc(range.from)} ${zoneFilter} GROUP BY 1 ORDER BY 2 DESC LIMIT 250`,
        prisma.$queryRaw<Row[]>`
          SELECT f."storageProviderId" AS provider, coalesce(r."country", 'XX') AS country, count(*) AS requests, coalesce(sum(r."bytesSent"), 0) AS bytes
          FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId"
          WHERE r."kind" <> 'api' AND r."timestamp" >= ${utc(range.from)} ${zoneFilter} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 400`,
        prisma.storageProvider.findMany({ select: { id: true, name: true, kind: true, region: true, servesCountries: true, healthStatus: true } }),
      ]);
      return {
        period: query.period,
        countries: countries.map((r) => ({ country: String(r.country), requests: num(r.requests), bytes: num(r.bytes), hit_ratio: num(r.requests) ? Math.round((num(r.hits) / num(r.requests)) * 1000) / 1000 : 0, p50_ms: Math.round(num(r.p50)) })),
        origins: providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, region: p.region, country: p.servesCountries[0] ?? null, health: p.healthStatus })),
        flows: flows.map((r) => ({ from: String(r.provider), to: String(r.country), requests: num(r.requests), bytes: num(r.bytes) })),
      };
    },
  }),
];
