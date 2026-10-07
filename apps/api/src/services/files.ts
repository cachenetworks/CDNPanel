import type { FastifyRequest } from 'fastify';
import { getPrisma, type File } from '@cdn/database';
import { objectKeyForFile } from '@cdn/storage';
import { AppError, isValidId, newId } from '@cdn/shared';
import { canAccessChain, getFolderChain } from '../lib/folders.js';
import { driverForId } from '../lib/storageRegistry.js';
import { baseLogger } from '../lib/logger.js';

/** Loads a file by id, enforcing id format and folder-level access. */
export async function requireFile(req: FastifyRequest, id: string): Promise<File> {
  if (!isValidId('file', id)) throw new AppError('invalid_id', 'The file id is malformed.');
  const file = await getPrisma().file.findUnique({ where: { id } });
  if (!file) throw new AppError('file_not_found');
  if (file.folderId && req.auth?.type === 'session') {
    const folder = await getPrisma().folder.findUnique({ where: { id: file.folderId } });
    if (folder && !canAccessChain(req, await getFolderChain(folder))) throw new AppError('file_not_found');
  }
  return file;
}

/**
 * Deletes file records and their stored objects. Objects can be shared between records
 * (deduplication), so an object is only removed once no record references it.
 */
export async function deleteFiles(files: File[]): Promise<void> {
  const prisma = getPrisma();
  if (files.length === 0) return;
  await prisma.file.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  const keys = new Map<string, { providerId: string; key: string }>();
  for (const f of files) keys.set(`${f.storageProviderId}:${f.storageKey}`, { providerId: f.storageProviderId, key: f.storageKey });
  for (const { providerId, key } of keys.values()) {
    const stillUsed = await prisma.file.count({ where: { storageProviderId: providerId, storageKey: key } });
    if (stillUsed > 0) continue;
    try {
      const { driver } = await driverForId(providerId);
      await driver.delete(key);
    } catch (err) {
      baseLogger.error({ err, key }, 'failed to delete stored object');
    }
  }
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
      uploadedById: target.userId,
      uploadedByApiKeyId: target.apiKeyId,
      scannedAt: source.scannedAt,
    },
  });
}
