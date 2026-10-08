import { getPrisma, type File, type LifecycleRule, type Prisma } from '@cdn/database';
import { audit } from '../lib/audit.js';
import { baseLogger } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { getZones } from '../lib/zones.js';
import { deleteFiles, deleteUnreferencedObjects, trashFiles } from './files.js';
import { openFileStream } from './replication.js';
import { autoPurgeFiles } from './purge.js';

const log = baseLogger.child({ service: 'lifecycle' });
const BATCH = 500;

/** Copies a file's current object to another provider and repoints the record. */
export async function moveFileStorage(file: File, targetProviderId: string, storageClass?: string): Promise<void> {
  if (file.storageProviderId === targetProviderId) return;
  const prisma = getPrisma();
  const { driver: target } = await driverForId(targetProviderId);
  const existing = await target.head(file.storageKey).catch(() => null);
  if (!existing || existing.size !== Number(file.size)) {
    const { stream } = await openFileStream(file, null);
    await target.put(file.storageKey, stream, { contentType: 'application/octet-stream', size: Number(file.size) });
    const info = await target.head(file.storageKey);
    if (!info || info.size !== Number(file.size)) throw new Error('copy verification failed');
  }
  await prisma.file.update({ where: { id: file.id }, data: { storageProviderId: targetProviderId, ...(storageClass ? { storageClass } : {}) } });
  // A replica on the target provider is now the primary copy.
  await prisma.fileReplica.deleteMany({ where: { fileId: file.id, storageProviderId: targetProviderId } });
  await deleteUnreferencedObjects([{ providerId: file.storageProviderId, key: file.storageKey }]);
}

async function ruleScope(rule: LifecycleRule): Promise<Prisma.FileWhereInput | null> {
  if (rule.zoneId) {
    const zone = (await getZones()).byId.get(rule.zoneId);
    const root = zone?.rootFolder?.path;
    if (!root) return null;
    return { folder: { OR: [{ path: root }, { path: { startsWith: `${root}/` } }] } };
  }
  if (rule.folderId) {
    const folder = await getPrisma().folder.findUnique({ where: { id: rule.folderId } });
    if (!folder) return null;
    return { folder: { OR: [{ path: folder.path }, { path: { startsWith: `${folder.path}/` } }] } };
  }
  return {};
}

/** Files a rule currently applies to (used by the worker and the dry-run preview). */
export async function matchingFiles(rule: LifecycleRule, take = BATCH): Promise<File[]> {
  const scope = await ruleScope(rule);
  if (!scope) return [];
  const cutoff = new Date(Date.now() - rule.afterDays * 86_400_000);
  const where: Prisma.FileWhereInput = {
    AND: [
      scope,
      { deletedAt: null, status: 'READY' },
      rule.basis === 'last_accessed' ? { OR: [{ lastAccessedAt: { lt: cutoff } }, { lastAccessedAt: null, createdAt: { lt: cutoff } }] } : { createdAt: { lt: cutoff } },
      rule.mimePrefix ? { mimeType: { startsWith: rule.mimePrefix } } : {},
      (rule.action === 'ARCHIVE' || rule.action === 'MOVE_STORAGE') && rule.targetStorageProviderId ? { storageProviderId: { not: rule.targetStorageProviderId } } : {},
    ],
  };
  return getPrisma().file.findMany({ where, take, orderBy: { createdAt: 'asc' } });
}

export async function applyRule(rule: LifecycleRule): Promise<number> {
  const files = await matchingFiles(rule);
  if (files.length === 0) {
    await getPrisma().lifecycleRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date(), lastRunCount: 0 } });
    return 0;
  }
  const settings = await getSettings();
  let count = 0;
  switch (rule.action) {
    case 'TRASH':
      await trashFiles(files, null, settings.files.trashRetentionDays);
      count = files.length;
      break;
    case 'DELETE':
      await deleteFiles(files);
      count = files.length;
      break;
    case 'ARCHIVE':
    case 'MOVE_STORAGE':
      if (!rule.targetStorageProviderId) break;
      for (const f of files) {
        try {
          await moveFileStorage(f, rule.targetStorageProviderId, rule.action === 'ARCHIVE' ? 'archive' : undefined);
          count++;
        } catch (err) {
          log.warn({ file_id: f.id, err: (err as Error).message }, 'lifecycle move failed');
        }
      }
      break;
  }
  if (rule.action === 'TRASH' || rule.action === 'DELETE') await autoPurgeFiles(files, `lifecycle rule ${rule.name}`);
  await getPrisma().lifecycleRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date(), lastRunCount: count } });
  await audit({ actorType: 'system', actorLabel: 'lifecycle' }, 'LIFECYCLE_APPLIED', { type: 'lifecycle_rule', id: rule.id }, { action: rule.action, files: count, sample: files.slice(0, 20).map((f) => f.id) });
  return count;
}

/** Moves files whose expiry has passed to the recycle bin. */
export async function expireFiles(): Promise<number> {
  const prisma = getPrisma();
  const settings = await getSettings();
  const files = await prisma.file.findMany({ where: { expiresAt: { lt: new Date() }, deletedAt: null }, take: BATCH });
  if (files.length === 0) return 0;
  await trashFiles(files, null, settings.files.trashRetentionDays);
  for (const f of files) {
    await audit({ actorType: 'system', actorLabel: 'lifecycle' }, 'FILE_EXPIRED', { type: 'file', id: f.id }, { name: f.name, expires_at: f.expiresAt });
    await emitWebhookEvent('file.expired', { file: { id: f.id, name: f.name, folder_id: f.folderId } });
  }
  await autoPurgeFiles(files, 'expired');
  return files.length;
}

/** Permanently deletes recycle-bin entries older than the retention window. */
export async function purgeTrash(): Promise<number> {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.files.trashRetentionDays * 86_400_000);
  const files = await getPrisma().file.findMany({ where: { deletedAt: { lt: cutoff } }, take: BATCH });
  await deleteFiles(files);
  return files.length;
}

/** Keeps at most `maxVersionsPerFile` previous revisions per file. */
export async function pruneVersions(): Promise<number> {
  const prisma = getPrisma();
  const settings = await getSettings();
  const max = settings.files.maxVersionsPerFile;
  const over = await prisma.$queryRaw<{ fileId: string }[]>`SELECT "fileId" FROM "FileVersion" GROUP BY "fileId" HAVING count(*) > ${max} LIMIT 500`;
  let removed = 0;
  for (const { fileId } of over) {
    const old = await prisma.fileVersion.findMany({ where: { fileId }, orderBy: { version: 'desc' }, skip: max });
    await prisma.fileVersion.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
    await deleteUnreferencedObjects(old.map((v) => ({ providerId: v.storageProviderId, key: v.storageKey })));
    removed += old.length;
  }
  return removed;
}

/** Worker entry point (daily + on demand). */
export async function runLifecycle(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.expired = await expireFiles();
  for (const rule of await getPrisma().lifecycleRule.findMany({ where: { enabled: true } })) {
    try {
      out[rule.id] = await applyRule(rule);
    } catch (err) {
      log.error({ err, rule_id: rule.id }, 'lifecycle rule failed');
    }
  }
  out.trash_purged = await purgeTrash();
  out.versions_pruned = await pruneVersions();
  return out;
}
