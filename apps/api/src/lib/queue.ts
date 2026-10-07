import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { bullConnection } from './redis.js';

export const QUEUE_NAMES = {
  fileProcessing: 'file-processing',
  webhooks: 'webhooks',
  maintenance: 'maintenance',
} as const;

export interface FileProcessingJob {
  fileId: string;
}
export interface WebhookJob {
  deliveryId: string;
}
export type MaintenanceJobName =
  | 'cleanup-expired-uploads'
  | 'prune-retention'
  | 'aggregate-analytics'
  | 'expire-sessions';

let connection: Redis | undefined;
const queues = new Map<string, Queue>();

function conn(): Redis {
  if (!connection) connection = bullConnection();
  return connection;
}

export function getQueue(name: (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: conn(),
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueueFileProcessing(fileId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.fileProcessing).add('process', { fileId } satisfies FileProcessingJob, {
    jobId: `process-${fileId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export async function enqueueWebhookDelivery(deliveryId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.webhooks).add('deliver', { deliveryId } satisfies WebhookJob, {
    jobId: deliveryId,
    attempts: 8,
    // 10s, 20s, 40s ... ~21 min total
    backoff: { type: 'exponential', delay: 10_000 },
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = undefined;
  }
}
