import { Worker, type Job } from 'bullmq';
import { disconnectPrisma } from '@cdn/database';
import { env } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';
import { bullConnection, closeRedis } from '../lib/redis.js';
import { QUEUE_NAMES, closeQueues, getQueue, type FileProcessingJob, type MaintenanceJobName, type WebhookJob } from '../lib/queue.js';
import { markProcessingFailed, processFile } from './processFile.js';
import { deliverWebhook, markWebhookFailed } from './deliverWebhook.js';
import { aggregateAnalytics, cleanupExpiredUploads, expireSessions, pruneRetention } from './maintenance.js';

const log = baseLogger.child({ service: 'cdn-worker' });

async function main() {
  try {
    env();
  } catch (err) {
    log.fatal((err as Error).message);
    process.exit(1);
  }

  const fileWorker = new Worker<FileProcessingJob>(QUEUE_NAMES.fileProcessing, async (job) => processFile(job.data.fileId), {
    connection: bullConnection(),
    concurrency: 4,
  });
  fileWorker.on('failed', (job, err) => {
    log.error({ err, file_id: job?.data.fileId, attempt: job?.attemptsMade }, 'file processing failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markProcessingFailed(job.data.fileId, err.message);
  });

  const webhookWorker = new Worker<WebhookJob>(QUEUE_NAMES.webhooks, async (job: Job<WebhookJob>) => deliverWebhook(job.data.deliveryId, job.attemptsMade + 1), {
    connection: bullConnection(),
    concurrency: 8,
  });
  webhookWorker.on('failed', (job, err) => {
    log.warn({ err: err.message, delivery_id: job?.data.deliveryId, attempt: job?.attemptsMade }, 'webhook delivery failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markWebhookFailed(job.data.deliveryId);
  });

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
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  maintenanceWorker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'maintenance job failed'));

  // Repeatable schedules (idempotent: BullMQ dedupes by name + pattern).
  const q = getQueue(QUEUE_NAMES.maintenance);
  await q.add('cleanup-expired-uploads', {}, { repeat: { pattern: '*/30 * * * *' }, jobId: 'cleanup-expired-uploads' });
  await q.add('aggregate-analytics', {}, { repeat: { pattern: '*/15 * * * *' }, jobId: 'aggregate-analytics' });
  await q.add('prune-retention', {}, { repeat: { pattern: '30 3 * * *' }, jobId: 'prune-retention' });
  await q.add('expire-sessions', {}, { repeat: { pattern: '0 4 * * *' }, jobId: 'expire-sessions' });

  log.info('worker started');

  const shutdown = async () => {
    log.info('worker shutting down');
    await Promise.allSettled([fileWorker.close(), webhookWorker.close(), maintenanceWorker.close()]);
    await closeQueues();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
