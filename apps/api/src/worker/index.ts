import { MetricsTime, Worker, type Job } from 'bullmq';
import { disconnectPrisma } from '@cdn/database';
import { env } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';
import { bullConnection, closeRedis, getRedis } from '../lib/redis.js';
import {
  QUEUE_NAMES,
  closeQueues,
  getQueue,
  type EdgeJob,
  type FileProcessingJob,
  type MaintenanceJobName,
  type MediaJob,
  type ReplicationJob,
  type WebhookJob,
} from '../lib/queue.js';
import { stopTelemetry } from '../lib/telemetry.js';
import { markProcessingFailed, processFile } from './processFile.js';
import { deliverWebhook, markWebhookFailed } from './deliverWebhook.js';
import { aggregateAnalytics, cleanupExpiredUploads, expireSessions, pruneRetention } from './maintenance.js';
import { checkDomains } from '../services/domains.js';
import { garbageCollectVariants } from '../services/images.js';
import { runLifecycle } from '../services/lifecycle.js';
import { processMedia } from '../services/media.js';
import { executePurge, prewarmUrls } from '../services/purge.js';
import { checkProviderHealth, repairReplicas, replicateFile } from '../services/replication.js';
import { evaluateQuotaAlerts } from '../services/usage.js';
import { getSettings } from '../lib/settings.js';
import { getPrisma } from '@cdn/database';

const log = baseLogger.child({ service: 'cdn-worker' });
// Per-minute completed / failed counts, shown on the Operations page.
const metrics = { maxDataPoints: MetricsTime.ONE_WEEK };

async function prewarmPopular(): Promise<number> {
  const settings = await getSettings();
  if (!settings.cache.prewarmTopFiles) return 0;
  const rows = await getPrisma().$queryRaw<{ id: string }[]>`
    SELECT r."fileId" AS id FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId"
    WHERE r."timestamp" > now() - interval '1 day' AND f."visibility" = 'PUBLIC' AND f."deletedAt" IS NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT ${settings.cache.prewarmTopFiles}`;
  const cdn = env().CDN_URL;
  await prewarmUrls(rows.map((r) => `${cdn}/files/${r.id}`));
  return rows.length;
}

async function main() {
  try {
    env();
  } catch (err) {
    log.fatal((err as Error).message);
    process.exit(1);
  }

  const fileWorker = new Worker<FileProcessingJob>(QUEUE_NAMES.fileProcessing, async (job) => processFile(job.data.fileId, { reprocess: job.data.reprocess }), {
    connection: bullConnection(),
    concurrency: 4,
    metrics,
  });
  fileWorker.on('failed', (job, err) => {
    log.error({ err, file_id: job?.data.fileId, attempt: job?.attemptsMade }, 'file processing failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markProcessingFailed(job.data.fileId, err.message);
  });

  const webhookWorker = new Worker<WebhookJob>(QUEUE_NAMES.webhooks, async (job: Job<WebhookJob>) => deliverWebhook(job.data.deliveryId, job.attemptsMade + 1), {
    connection: bullConnection(),
    concurrency: 8,
    metrics,
  });
  webhookWorker.on('failed', (job, err) => {
    log.warn({ err: err.message, delivery_id: job?.data.deliveryId, attempt: job?.attemptsMade }, 'webhook delivery failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markWebhookFailed(job.data.deliveryId);
  });

  // FFmpeg is CPU-bound: one rendition job at a time per worker process.
  const mediaWorker = new Worker<MediaJob>(QUEUE_NAMES.media, async (job) => processMedia(job.data.fileId, job.data.kinds), { connection: bullConnection(), concurrency: 1, lockDuration: 600_000, metrics });
  mediaWorker.on('failed', (job, err) => log.error({ err: err.message, file_id: job?.data.fileId }, 'media processing failed'));

  const replicationWorker = new Worker<ReplicationJob>(
    QUEUE_NAMES.replication,
    async (job) => replicateFile(job.data.fileId, job.data.providerId, job.attemptsMade + 1, job.opts.attempts ?? 1),
    { connection: bullConnection(), concurrency: 4, lockDuration: 300_000, metrics },
  );
  replicationWorker.on('failed', (job, err) => log.warn({ err: err.message, file_id: job?.data.fileId, provider_id: job?.data.providerId }, 'replication failed'));

  const edgeWorker = new Worker<EdgeJob>(
    QUEUE_NAMES.edge,
    async (job) => {
      if (job.data.type === 'purge') return executePurge(job.data.purgeId);
      const results = await prewarmUrls(job.data.urls);
      return { warmed: results.filter((r) => r.status && r.status < 400).length, total: results.length };
    },
    { connection: bullConnection(), concurrency: 2, metrics },
  );
  edgeWorker.on('failed', (job, err) => log.warn({ err: err.message, job: job?.name }, 'edge job failed'));

  const maintenanceWorker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job: Job) => {
      switch (job.name as MaintenanceJobName) {
        case 'cleanup-expired-uploads':
          return cleanupExpiredUploads();
        case 'aggregate-analytics':
          return aggregateAnalytics();
        case 'prune-retention':
          return pruneRetention();
        case 'expire-sessions':
          return expireSessions();
        case 'domain-health':
          return checkDomains();
        case 'provider-health':
          return checkProviderHealth();
        case 'replica-repair':
          return repairReplicas();
        case 'lifecycle':
          return runLifecycle();
        case 'quota-alerts':
          return evaluateQuotaAlerts();
        case 'trash-purge':
          return (await import('../services/lifecycle.js')).purgeTrash();
        case 'prewarm-popular':
          return prewarmPopular();
        case 'variant-gc':
          return garbageCollectVariants();
      }
    },
    { connection: bullConnection(), concurrency: 1, lockDuration: 900_000, metrics },
  );
  maintenanceWorker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'maintenance job failed'));

  // Repeatable schedules (idempotent: BullMQ dedupes by name + pattern).
  const q = getQueue(QUEUE_NAMES.maintenance);
  const schedules: [MaintenanceJobName, string][] = [
    ['cleanup-expired-uploads', '*/30 * * * *'],
    ['aggregate-analytics', '*/15 * * * *'],
    ['prune-retention', '30 3 * * *'],
    ['expire-sessions', '0 4 * * *'],
    ['domain-health', '*/5 * * * *'],
    ['provider-health', '*/2 * * * *'],
    ['replica-repair', '17 * * * *'],
    ['lifecycle', '45 2 * * *'],
    ['quota-alerts', '*/10 * * * *'],
    ['trash-purge', '15 * * * *'],
    ['prewarm-popular', '5 */6 * * *'],
    ['variant-gc', '0 5 * * 0'],
  ];
  for (const [name, pattern] of schedules) await q.add(name, {}, { repeat: { pattern }, jobId: name });

  // Heartbeat for the Operations page and Prometheus.
  const heartbeat = setInterval(() => void getRedis().set('worker:heartbeat', String(Date.now()), 'EX', 300).catch(() => undefined), 15_000);
  void getRedis().set('worker:heartbeat', String(Date.now()), 'EX', 300);

  log.info('worker started');

  const shutdown = async () => {
    log.info('worker shutting down');
    clearInterval(heartbeat);
    await Promise.allSettled([fileWorker.close(), webhookWorker.close(), mediaWorker.close(), replicationWorker.close(), edgeWorker.close(), maintenanceWorker.close()]);
    await closeQueues();
    await closeRedis();
    await disconnectPrisma();
    await stopTelemetry();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
