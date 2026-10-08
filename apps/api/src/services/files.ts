import type { FastifyRequest } from 'fastify';
import { getPrisma, type File } from '@cdn/database';
import { objectKeyForFile } from '@cdn/storage';
import { AppError, isValidId, newId } from '@cdn/shared';
import { assertWithinApiKeyProject, canAccessChain, getFolderChain } from '../lib/folders.js';
import { driverForId } from '../lib/storageRegistry.js';
import { baseLogger } from '../lib/logger.js';

/**
 * Loads a file by id, enforcing id format, folder-level access and API-key project scope.
 * Files in the recycle bin are treated as missing unless `includeDeleted` is set.
 */
export async function requireFile(req: FastifyRequest, id: string, opts: { includeDeleted?: boolean } = {}): Promise<File> {
  if (!isValidId('file', id)) throw new AppError('invalid_id', 'The file id is malformed.');
  const file = await getPrisma().file.findUnique({ where: { id } });
  if (!file || (file.deletedAt && !opts.includeDeleted)) throw new AppError('file_not_found');
  let folderPath: string | null = null;
  if (file.folderId) {
    const folder = await getPrisma().folder.findUnique({ where: { id: file.folderId } });
    folderPath = folder?.path ?? null;
    if (folder && req.auth?.type === 'session' && !canAccessChain(req, await getFolderChain(folder))) throw new AppError('file_not_found');
  }
  await assertWithinApiKeyProject(req, folderPath, 'file_not_found');
  return file;
}

/** True when any file, revision or replica still points at the stored object. */
export async function objectReferenced(providerId: string, key: string): Promise<boolean> {
  const prisma = getPrisma();
  const [files, versions, replicas] = await Promise.all([
    prisma.file.count({ where: { storageProviderId: providerId, storageKey: key } }),
    prisma.fileVersion.count({ where: { storageProviderId: providerId, storageKey: key } }),
    prisma.fileReplica.count({ where: { storageProviderId: providerId, storageKey: key } }),
  ]);
  return files + versions + replicas > 0;
}

async function deleteObject(providerId: string, key: string): Promise<void> {
  try {
    const { driver } = await driverForId(providerId);
    await driver.delete(key);
  } catch (err) {
    baseLogger.error({ err, key }, 'failed to delete stored object');
  }
}

/** Deletes objects that are no longer referenced by any record. */
export async function deleteUnreferencedObjects(objects: Iterable<{ providerId: string; key: string }>): Promise<void> {
  const unique = new Map<string, { providerId: string; key: string }>();
  for (const o of objects) unique.set(`${o.providerId}:${o.key}`, o);
  for (const { providerId, key } of unique.values()) {
    if (await objectReferenced(providerId, key)) continue;
    await deleteObject(providerId, key);
  }
}

/**
 * Permanently deletes file records together with their revisions, replicas, image variants and
 * media renditions. Objects can be shared between records (deduplication, copies, revisions), so
 * an object is only removed once nothing references it.
 */
export async function deleteFiles(files: File[]): Promise<void> {
  const prisma = getPrisma();
  if (files.length === 0) return;
  const ids = files.map((f) => f.id);
  const [versions, replicas, variants, renditions] = await Promise.all([
    prisma.fileVersion.findMany({ where: { fileId: { in: ids } }, select: { storageProviderId: true, storageKey: true } }),
    prisma.fileReplica.findMany({ where: { fileId: { in: ids } }, select: { storageProviderId: true, storageKey: true } }),
    prisma.imageVariant.findMany({ where: { fileId: { in: ids } }, select: { storageProviderId: true, storageKey: true } }),
    prisma.mediaRendition.findMany({ where: { fileId: { in: ids } }, select: { storageProviderId: true, storageKey: true, metadata: true } }),
  ]);
  // Cascades remove versions, replicas, variants, renditions and share links.
  await prisma.file.deleteMany({ where: { id: { in: ids } } });
  await deleteUnreferencedObjects([
    ...files.map((f) => ({ providerId: f.storageProviderId, key: f.storageKey })),
    ...versions.map((v) => ({ providerId: v.storageProviderId, key: v.storageKey })),
    ...replicas.map((r) => ({ providerId: r.storageProviderId, key: r.storageKey })),
  ]);
  // Derived objects (variants, renditions) are never shared.
  for (const v of variants) await deleteObject(v.storageProviderId, v.storageKey);
  for (const r of renditions) {
    for (const key of renditionObjectKeys(r)) await deleteObject(r.storageProviderId, key);
  }
}

export function renditionObjectKeys(r: { storageKey: string; metadata: unknown }): string[] {
  const files = (r.metadata as { files?: unknown } | null)?.files;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) return files.map((f) => `${r.storageKey}/${f}`);
  return [r.storageKey];
}

/** Moves files to the recycle bin (or deletes them when trash retention is 0). */
export async function trashFiles(files: File[], actorUserId: string | null, retentionDays: number): Promise<'trashed' | 'deleted'> {
  if (files.length === 0) return 'trashed';
  if (retentionDays <= 0) {
    await deleteFiles(files);
    return 'deleted';
  }
  await getPrisma().file.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { deletedAt: new Date(), deletedById: actorUserId } });
  return 'trashed';
}

/** Copies a file. Content is immutable, so the stored object is shared rather than duplicated. */
export async function copyFile(source: File, target: { folderId: string | null; name: string; slug: string; userId: string | null; apiKeyId: string | null }): Promise<File> {
  const prisma = getPrisma();
  const id = newId('file');
  let storageKey = source.storageKey;
  if (!source.sha256) {
    // Legacy objects without checksum are physically copied to stay independent.
    const { driver } = await driverForId(source.storageProviderId);
    storageKey = objectKeyForFile(id);
    await driver.copy(source.storageKey, storageKey);
  }
  return prisma.file.create({
    data: {
      id,
      name: target.name,
      slug: target.slug,
      folderId: target.folderId,
      mimeType: source.mimeType,
      extension: source.extension,
      size: source.size,
      sha256: source.sha256,
      storageProviderId: source.storageProviderId,
      storageKey,
      visibility: source.visibility,
      status: source.status,
      statusReason: source.statusReason,
      cacheControl: source.cacheControl,
      forceDownload: source.forceDownload,
      width: source.width,
      height: source.height,
      durationSeconds: source.durationSeconds,
      metadata: source.metadata ?? {},
      cacheTags: source.cacheTags,
      uploadedById: target.userId,
      uploadedByApiKeyId: target.apiKeyId,
      scannedAt: source.scannedAt,
    },
  });
}
