import type { Readable } from 'node:stream';
import { getPrisma, type File, type StorageProvider } from '@cdn/database';
import type { ByteRange } from '@cdn/storage';
import { newId } from '@cdn/shared';
import { audit } from '../lib/audit.js';
import { baseLogger } from '../lib/logger.js';
import { enqueueReplication } from '../lib/queue.js';
import { driverFor, driverForId } from '../lib/storageRegistry.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { getZones, zoneForFolder, zoneForPath, folderPathOf, type ZoneWithRelations } from '../lib/zones.js';

const log = baseLogger.child({ service: 'replication' });

// ─── Provider health (cached for delivery decisions) ────────────────────────

let providers: { at: number; rows: Map<string, StorageProvider> } | null = null;

export async function providerMap(): Promise<Map<string, StorageProvider>> {
  if (providers && Date.now() - providers.at < 15_000) return providers.rows;
  const rows = await getPrisma().storageProvider.findMany();
  providers = { at: Date.now(), rows: new Map(rows.map((p) => [p.id, p])) };
  return providers.rows;
}

/** Runs each enabled provider's health check and records status and latency (worker job). */
/** How often object-storage buckets are listed to measure usage (listing is a billed request on B2 / S3). */
const USAGE_SCAN_INTERVAL_MS = 30 * 60_000;

/** Records how much a cloud bucket really holds, at most every 30 minutes per provider. */
export async function measureBucketUsage(p: StorageProvider, force = false): Promise<void> {
  if (p.kind === 'LOCAL' || p.kind === 'POOL') return;
  if (!force && p.usageCheckedAt && Date.now() - p.usageCheckedAt.getTime() < USAGE_SCAN_INTERVAL_MS) return;
  const driver = driverFor(p);
  if (!driver.measureUsage) return;
  const usage = await driver.measureUsage({ maxPages: 100 });
  await getPrisma().storageProvider.update({
    where: { id: p.id },
    data: { bucketUsedBytes: BigInt(usage.bytes), bucketObjectCount: usage.objects, bucketUsagePartial: usage.partial, usageCheckedAt: new Date() },
  });
}

export async function checkProviderHealth(): Promise<void> {
  const prisma = getPrisma();
  for (const p of await prisma.storageProvider.findMany({ where: { enabled: true } })) {
    const started = Date.now();
    let status = 'healthy';
    try {
      await Promise.race([driverFor(p).healthCheck(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000))]);
    } catch (err) {
      status = 'unhealthy';
      log.warn({ provider_id: p.id, err: (err as Error).message }, 'storage provider unhealthy');
    }
    await prisma.storageProvider.update({ where: { id: p.id }, data: { healthStatus: status, healthCheckedAt: new Date(), latencyMs: Date.now() - started } });
    await measureBucketUsage(p).catch((err: unknown) => log.warn({ provider_id: p.id, err: (err as Error).message }, 'bucket usage scan failed'));
  }
  providers = null;
}

// ─── Scheduling & copying ───────────────────────────────────────────────────

export function replicaTargets(zone: ZoneWithRelations | null, primaryId: string): string[] {
  if (!zone || zone.replicaProviderIds.length === 0) return [];
  return [...new Set(zone.replicaProviderIds)].filter((id) => id !== primaryId);
}

/** Creates/refreshes replica rows for a file and queues the copies. */
export async function scheduleReplication(file: Pick<File, 'id' | 'folderId' | 'storageProviderId' | 'storageKey' | 'sha256'>, opts: { force?: boolean } = {}): Promise<number> {
  const zone = await zoneForFolder(file.folderId);
  const targets = replicaTargets(zone, file.storageProviderId);
  const prisma = getPrisma();
  let queued = 0;
  for (const providerId of targets) {
    const existing = await prisma.fileReplica.findUnique({ where: { fileId_storageProviderId: { fileId: file.id, storageProviderId: providerId } } });
    if (existing && existing.status === 'SYNCED' && existing.sha256 === file.sha256 && !opts.force) continue;
    await prisma.fileReplica.upsert({
      where: { fileId_storageProviderId: { fileId: file.id, storageProviderId: providerId } },
      create: { id: newId('replica'), fileId: file.id, storageProviderId: providerId, storageKey: file.storageKey, status: 'PENDING' },
      update: { status: 'PENDING', storageKey: file.storageKey, error: null },
    });
    await enqueueReplication(file.id, providerId);
    queued++;
  }
  return queued;
}

/** Copies a file's current content to a replica provider (worker). */
export async function replicateFile(fileId: string, providerId: string, attempt: number, maxAttempts: number): Promise<void> {
  const prisma = getPrisma();
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  const replica = await prisma.fileReplica.findUnique({ where: { fileId_storageProviderId: { fileId, storageProviderId: providerId } } });
  if (!file || !replica || file.status !== 'READY') return;
  if (replica.status === 'SYNCED' && replica.sha256 === file.sha256) return;
  try {
    const { driver: target } = await driverForId(providerId);
    const existing = await target.head(file.storageKey).catch(() => null);
    if (!existing || existing.size !== Number(file.size)) {
      const source = await openFileStream(file, null);
      await target.put(file.storageKey, source.stream, { contentType: 'application/octet-stream', size: Number(file.size) });
      const info = await target.head(file.storageKey);
      if (!info || info.size !== Number(file.size)) throw new Error(`size mismatch after copy (${info?.size ?? 'missing'} != ${file.size})`);
    }
    // Replicas of an older object key (before a content replacement) become orphaned once re-synced.
    const oldKey = replica.storageKey !== file.storageKey ? replica.storageKey : null;
    await prisma.fileReplica.update({
      where: { id: replica.id },
      data: { status: 'SYNCED', sha256: file.sha256, storageKey: file.storageKey, syncedAt: new Date(), lastCheckedAt: new Date(), error: null, attempts: { increment: 1 } },
    });
    if (oldKey) {
      const { deleteUnreferencedObjects } = await import('./files.js');
      await deleteUnreferencedObjects([{ providerId, key: oldKey }]);
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    const final = attempt >= maxAttempts;
    await prisma.fileReplica.update({ where: { id: replica.id }, data: { status: final ? 'FAILED' : 'PENDING', error: message, attempts: { increment: 1 } } });
    if (final) {
      const zone = await zoneForFolder(file.folderId);
      await emitWebhookEvent('replication.failed', { file_id: file.id, provider_id: providerId, error: message }, { projectId: zone?.projectId });
    }
    throw err;
  }
}

/**
 * Verifies replicas (oldest-checked first), re-queues missing / stale ones and creates rows for
 * files whose zone gained replica providers. Run periodically by the worker.
 */
export async function repairReplicas(batch = 200): Promise<{ checked: number; requeued: number; created: number }> {
  const prisma = getPrisma();
  let requeued = 0;
  const replicas = await prisma.fileReplica.findMany({
    where: { status: { in: ['SYNCED', 'FAILED', 'MISSING'] } },
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: batch,
    include: { file: { select: { id: true, size: true, sha256: true, storageKey: true, status: true, deletedAt: true } } },
  });
  for (const r of replicas) {
    if (r.file.status !== 'READY') continue;
    let healthy = false;
    if (r.status === 'SYNCED' && r.sha256 === r.file.sha256) {
      try {
        const { driver } = await driverForId(r.storageProviderId);
        const info = await driver.head(r.storageKey);
        healthy = Boolean(info && info.size === Number(r.file.size));
      } catch {
        healthy = false;
      }
    }
    if (healthy) {
      await prisma.fileReplica.update({ where: { id: r.id }, data: { lastCheckedAt: new Date() } });
      continue;
    }
    await prisma.fileReplica.update({ where: { id: r.id }, data: { status: r.status === 'SYNCED' ? 'MISSING' : r.status, lastCheckedAt: new Date(), attempts: 0 } });
    await enqueueReplication(r.fileId, r.storageProviderId);
    requeued++;
  }

  // Backfill: zones with replica providers but files lacking replica rows.
  let created = 0;
  const reg = await getZones();
  for (const zone of reg.zones) {
    if (!zone.rootFolder || zone.replicaProviderIds.length === 0) continue;
    const root = zone.rootFolder.path;
    const missing = await prisma.file.findMany({
      where: {
        status: 'READY',
        deletedAt: null,
        folder: { OR: [{ path: root }, { path: { startsWith: `${root}/` } }] },
        NOT: { replicas: { some: { storageProviderId: { in: zone.replicaProviderIds } } } },
      },
      take: batch,
      select: { id: true, folderId: true, storageProviderId: true, storageKey: true, sha256: true },
    });
    for (const f of missing) created += await scheduleReplication(f);
  }
  return { checked: replicas.length, requeued, created };
}

export async function triggerZoneReplication(zone: { id: string }, actorLabel: string): Promise<number> {
  const result = await repairReplicas(1000);
  await audit({ actorType: 'system', actorLabel }, 'REPLICATION_TRIGGERED', { type: 'zone', id: zone.id }, result);
  return result.created + result.requeued;
}

// ─── Source selection for delivery ──────────────────────────────────────────

export interface SourceCandidate {
  providerId: string;
  key: string;
  role: 'primary' | 'replica';
}

/** Orders the storage locations a file may be served from, according to the zone strategy. */
export async function sourceCandidates(file: Pick<File, 'id' | 'storageProviderId' | 'storageKey' | 'sha256'>, zone: ZoneWithRelations | null, country: string | null): Promise<SourceCandidate[]> {
  const primary: SourceCandidate = { providerId: file.storageProviderId, key: file.storageKey, role: 'primary' };
  const strategy = zone?.replicationStrategy ?? 'PRIMARY_ONLY';
  if (strategy === 'PRIMARY_ONLY') return [primary];
  const replicas = await getPrisma().fileReplica.findMany({ where: { fileId: file.id, status: 'SYNCED' } });
  const synced: SourceCandidate[] = replicas
    .filter((r) => r.sha256 === file.sha256)
    .map((r) => ({ providerId: r.storageProviderId, key: r.storageKey, role: 'replica' as const }));
  if (synced.length === 0) return [primary];
  const map = await providerMap();
  const healthy = (c: SourceCandidate) => map.get(c.providerId)?.healthStatus !== 'unhealthy' && map.get(c.providerId)?.enabled !== false;
  const byPriority = (a: SourceCandidate, b: SourceCandidate) => (map.get(a.providerId)?.priority ?? 100) - (map.get(b.providerId)?.priority ?? 100) || (map.get(a.providerId)?.latencyMs ?? 1e9) - (map.get(b.providerId)?.latencyMs ?? 1e9);
  switch (strategy) {
    case 'MIRROR':
      return [primary, ...synced.sort(byPriority)];
    case 'FAILOVER': {
      const all = [primary, ...synced.sort(byPriority)];
      return [...all.filter(healthy), ...all.filter((c) => !healthy(c))];
    }
    case 'NEAREST': {
      const all = [primary, ...synced];
      const local = (c: SourceCandidate) => Boolean(country && map.get(c.providerId)?.servesCountries.includes(country));
      return all.sort((a, b) => Number(healthy(b)) - Number(healthy(a)) || Number(local(b)) - Number(local(a)) || byPriority(a, b));
    }
  }
}

/**
 * Opens a read stream for a file, trying each candidate location in order (failover).
 * Returns the provider that served it.
 */
export async function openFileStream(
  file: Pick<File, 'id' | 'storageProviderId' | 'storageKey' | 'sha256' | 'folderId'>,
  range: ByteRange | null,
  candidates?: SourceCandidate[],
): Promise<{ stream: Readable; providerId: string; role: 'primary' | 'replica' }> {
  let list = candidates;
  if (!list) {
    const reg = await getZones();
    const zone = zoneForPath(reg, await folderPathOf(file.folderId));
    const ordered = await sourceCandidates(file, zone, null);
    // Background readers (replication, processing) may always fall back to replicas.
    list = ordered.length > 1 ? ordered : [{ providerId: file.storageProviderId, key: file.storageKey, role: 'primary' }, ...(await syncedReplicas(file))];
  }
  let lastErr: unknown;
  for (const c of list) {
    try {
      const { driver } = await driverForId(c.providerId);
      return { stream: await driver.get(c.key, range ?? undefined), providerId: c.providerId, role: c.role };
    } catch (err) {
      lastErr = err;
      log.warn({ file_id: file.id, provider_id: c.providerId, err: (err as Error).message }, 'storage read failed, trying next location');
    }
  }
  throw lastErr ?? new Error('no storage location available');
}

async function syncedReplicas(file: Pick<File, 'id' | 'sha256'>): Promise<SourceCandidate[]> {
  const rows = await getPrisma().fileReplica.findMany({ where: { fileId: file.id, status: 'SYNCED' } });
  return rows.filter((r) => r.sha256 === file.sha256).map((r) => ({ providerId: r.storageProviderId, key: r.storageKey, role: 'replica' as const }));
}
