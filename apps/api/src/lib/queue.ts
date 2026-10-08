import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { bullConnection } from './redis.js';

export const QUEUE_NAMES = {
  fileProcessing: 'file-processing',
  webhooks: 'webhooks',
  maintenance: 'maintenance',
  media: 'media',
  replication: 'replication',
  edge: 'edge',
  pools: 'pools',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export const ALL_QUEUES = Object.values(QUEUE_NAMES) as QueueName[];

export interface FileProcessingJob {
  fileId: string;
  /** Content was replaced: re-run metadata, renditions and replication. */
  reprocess?: boolean;
}
export interface WebhookJob {
  deliveryId: string;
}
export interface MediaJob {
  fileId: string;
  /** Specific renditions to (re)build; default = the configured set. */
  kinds?: string[];
}
export interface ReplicationJob {
  fileId: string;
  providerId: string;
}
/** Rebuild / scrub of a RAID pool (`verify` also checks every shard's presence and length). */
export interface PoolJob {
  poolId: string;
  verify?: boolean;
  /** Slots to rewrite even if manifests think they are fine (e.g. a replaced node). */
  positions?: number[];
  reason?: string;
}
export type EdgeJob = { type: 'purge'; purgeId: string } | { type: 'prewarm'; urls: string[] };

export type MaintenanceJobName =
  | 'cleanup-expired-uploads'
  | 'prune-retention'
  | 'aggregate-analytics'
  | 'expire-sessions'
  | 'domain-health'
  | 'provider-health'
  | 'replica-repair'
  | 'lifecycle'
  | 'quota-alerts'
  | 'trash-purge'
  | 'prewarm-popular'
  | 'variant-gc'
  | 'node-health'
  | 'pool-scrub';

let connection: Redis | undefined;
const queues = new Map<string, Queue>();

function conn(): Redis {
  if (!connection) connection = bullConnection();
  return connection;
}

export function getQueue(name: QueueName): Queue {
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

export async function enqueueFileProcessing(fileId: string, opts: { reprocess?: boolean } = {}): Promise<void> {
  await getQueue(QUEUE_NAMES.fileProcessing).add('process', { fileId, reprocess: opts.reprocess } satisfies FileProcessingJob, {
    // Re-processing after a content replacement must not be deduplicated against the first run.
    jobId: opts.reprocess ? `process-${fileId}-${Date.now()}` : `process-${fileId}`,
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

export async function enqueueMedia(fileId: string, kinds?: string[]): Promise<void> {
  await getQueue(QUEUE_NAMES.media).add('render', { fileId, kinds } satisfies MediaJob, {
    jobId: `media-${fileId}-${Date.now()}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
  });
}

export async function enqueueReplication(fileId: string, providerId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.replication).add('replicate', { fileId, providerId } satisfies ReplicationJob, {
    jobId: `rep-${fileId}-${providerId}-${Date.now()}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 15_000 },
  });
}

export async function enqueuePoolRepair(job: PoolJob): Promise<void> {
  // One queued run per pool at a time; a running job is not affected.
  await getQueue(QUEUE_NAMES.pools).add('repair', job, { jobId: `pool-${job.poolId}-${job.verify ? 'verify' : 'repair'}`, removeOnComplete: true, removeOnFail: 50 });
}

export async function enqueueEdge(job: EdgeJob): Promise<void> {
  await getQueue(QUEUE_NAMES.edge).add(job.type, job, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = undefined;
  }
}
