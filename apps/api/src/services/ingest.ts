import { createHash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { getPrisma, Prisma, type File, type StorageProvider, type Visibility } from '@cdn/database';
import { objectKeyForFile } from '@cdn/storage';
import {
  AppError,
  extensionOf,
  isActiveContentType,
  mimeMatches,
  newId,
  normalizeName,
  slugifySegment,
  InvalidNameError,
} from '@cdn/shared';
import { env } from '../config/env.js';
import { getSettings } from '../lib/settings.js';
import { driverFor, uploadProvider } from '../lib/storageRegistry.js';
import { sniffContent, SNIFF_BYTES, type SniffResult } from '../lib/sniff.js';
import { inheritedVisibility } from '../lib/folders.js';
import { enqueueFileProcessing } from '../lib/queue.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { audit, type AuditContext } from '../lib/audit.js';
import { scannerFromEnv } from '../lib/scanner.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';
import { zoneForFolder, type ZoneWithRelations } from '../lib/zones.js';
import { assertUploadQuota } from './usage.js';
import { purgeVariants } from './images.js';
import { autoPurgeFiles } from './purge.js';
import { providerSpace } from './storageCapacity.js';

/** Pass-through stream that hashes, counts and captures the first bytes for sniffing. */
class Inspector extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  private headChunks: Buffer[] = [];
  private headLen = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(new AppError('file_too_large'));
      return;
    }
    this.hash.update(chunk);
    if (this.headLen < SNIFF_BYTES) {
      const slice = chunk.subarray(0, SNIFF_BYTES - this.headLen);
      this.headChunks.push(slice);
      this.headLen += slice.length;
    }
    cb(null, chunk);
  }

  head(): Buffer {
    return Buffer.concat(this.headChunks);
  }
}

export interface IngestInput {
  stream: Readable;
  filename: string;
  /** Declared size, if known (chunked uploads) — used for early quota checks. */
  declaredSize?: number;
  folderId: string | null;
  visibility?: Visibility;
  cacheControl?: string | null;
  forceDownload?: boolean;
  metadata?: Record<string, unknown>;
  cacheTags?: string[];
  /** Move the file to the recycle bin automatically after this date. */
  expiresAt?: Date | null;
  expectedSha256?: string | null;
  userId: string | null;
  apiKeyId: string | null;
  actor: AuditContext;
  /** Storage provider override (chunked uploads pin the provider at init). */
  storageProviderId?: string;
}

export interface UploadContext {
  folderId: string | null;
  apiKeyId: string | null;
  declaredSize?: number;
}

/** Validates name, extension, size and quotas before any bytes are stored. */
export async function assertUploadAllowed(filename: string, ctx: UploadContext): Promise<{ name: string; maxSize: number; zone: ZoneWithRelations | null }> {
  const settings = await getSettings();
  let name: string;
  try {
    name = normalizeName(filename, 'file');
  } catch (err) {
    if (err instanceof InvalidNameError) throw new AppError('validation_failed', 'The file name is invalid.');
    throw err;
  }
  const ext = extensionOf(name);
  if (ext && settings.uploads.blockedExtensions.includes(ext)) {
    throw new AppError('unsupported_file_type', `Files with the .${ext} extension are not allowed.`);
  }
  const zone = await zoneForFolder(ctx.folderId);
  let maxSize = Math.min(settings.uploads.maxFileSize, env().MAX_UPLOAD_SIZE);
  if (zone?.maxFileSize) maxSize = Math.min(maxSize, Number(zone.maxFileSize));
  if (ctx.declaredSize !== undefined && ctx.declaredSize > maxSize) throw new AppError('file_too_large');
  if (settings.uploads.quotaBytes !== null && ctx.declaredSize !== undefined) {
    const used = await storageUsed();
    if (used + ctx.declaredSize > settings.uploads.quotaBytes) throw new AppError('quota_exceeded');
  }
  if (ctx.declaredSize !== undefined) await assertUploadQuota(zone, ctx.apiKeyId, ctx.declaredSize);
  if (settings.uploads.requireMalwareScan && !env().CLAMAV_HOST) {
    throw new AppError('service_unavailable', 'Malware scanning is required but no scanner is configured.');
  }
  return { name, maxSize, zone };
}

export async function storageUsed(): Promise<number> {
  const agg = await getPrisma().file.aggregate({ _sum: { size: true } });
  return Number(agg._sum.size ?? 0);
}

/** Finds a slug not used by another file in the same folder: logo.png, logo-1.png, ... */
export async function uniqueFileSlug(folderId: string | null, name: string, excludeId?: string): Promise<string> {
  const base = slugifySegment(name);
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  const prisma = getPrisma();
  const existing = new Set(
    (
      await prisma.file.findMany({
        where: { folderId, slug: { startsWith: stem }, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { slug: true },
      })
    ).map((f) => f.slug),
  );
  if (!existing.has(base)) return base;
  for (let i = 1; i < 10_000; i++) {
    const candidate = ext ? `${stem}-${i}.${ext}` : `${stem}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext ? `.${ext}` : ''}`;
}

export interface StoredUpload {
  provider: StorageProvider;
  /** Final object key (an existing object's key when deduplicated). */
  storageKey: string;
  sha256: string;
  size: number;
  sniff: SniffResult;
  /** True when an identical, already-verified object was reused. */
  reused: boolean;
  /** Deletes the stored object if it was newly written (for rollbacks). */
  cleanup: () => Promise<void>;
}

/**
 * Streams content into storage while hashing and sniffing it, then enforces checksum, size,
 * MIME allowlists (global + zone) and quotas. Identical content is deduplicated.
 */
export async function storeUpload(input: {
  stream: Readable;
  name: string;
  objectId: string;
  maxSize: number;
  zone: ZoneWithRelations | null;
  declaredSize?: number;
  expectedSha256?: string | null;
  storageProviderId?: string;
  apiKeyId: string | null;
}): Promise<StoredUpload> {
  const settings = await getSettings();
  const prisma = getPrisma();
  const provider = input.storageProviderId
    ? await prisma.storageProvider.findUniqueOrThrow({ where: { id: input.storageProviderId } })
    : await uploadProvider(input.zone?.storageProviderId ?? settings.uploads.storageProviderId);
  const driver = driverFor(provider);
  const storageKey = objectKeyForFile(input.objectId);

  // Check the destination filesystem, not just the CDN's logical quota. A full
  // host volume can have plenty of apparent CDN quota remaining.
  const usedOnProvider = await prisma.file.aggregate({ where: { storageProviderId: provider.id }, _sum: { size: true } });
  const free = (await providerSpace(provider, Number(usedOnProvider._sum.size ?? 0))).available;
  if (free !== null && (free <= 0 || (input.declaredSize !== undefined && input.declaredSize > free))) {
    throw new AppError('quota_exceeded', 'The storage backend does not have enough available capacity.');
  }

  const inspector = new Inspector(input.maxSize);
  input.stream.on('error', (err) => inspector.destroy(err));
  // Errors are surfaced through the storage pipeline; avoid a duplicate unhandled 'error' event.
  inspector.on('error', () => undefined);
  try {
    await driver.put(storageKey, input.stream.pipe(inspector), { contentType: 'application/octet-stream', size: input.declaredSize });
  } catch (err) {
    await driver.delete(storageKey).catch(() => undefined);
    if (err instanceof AppError) throw err;
    const cause = (err as { causeError?: unknown }).causeError;
    if (cause instanceof AppError) throw cause;
    if ((input.stream as { truncated?: boolean }).truncated) throw new AppError('file_too_large');
    throw new AppError('storage_error');
  }
  const cleanupNew = () => driver.delete(storageKey).catch(() => undefined);
  if ((input.stream as { truncated?: boolean }).truncated || inspector.bytes > input.maxSize) {
    await cleanupNew();
    throw new AppError('file_too_large');
  }

  const sha256 = inspector.hash.digest('hex');
  const size = inspector.bytes;

  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
    await cleanupNew();
    throw new AppError('checksum_mismatch', undefined, { expected: input.expectedSha256.toLowerCase(), actual: sha256 });
  }
  if (input.declaredSize !== undefined && input.declaredSize !== size) {
    await cleanupNew();
    throw new AppError('validation_failed', `Received ${size} bytes but ${input.declaredSize} were declared.`);
  }

  const sniff = await sniffContent(inspector.head(), input.name);
  const allowLists = [settings.uploads.allowedMimeTypes, input.zone?.allowedMimeTypes ?? []].filter((l) => l.length > 0);
  for (const list of allowLists) {
    if (!list.some((p) => mimeMatches(p, sniff.mime))) {
      await cleanupNew();
      throw new AppError('unsupported_file_type', `Files of type ${sniff.mime} are not allowed${list === input.zone?.allowedMimeTypes ? ' in this zone' : ''}.`);
    }
  }

  try {
    if (settings.uploads.quotaBytes !== null && (await storageUsed()) + size > settings.uploads.quotaBytes) throw new AppError('quota_exceeded');
    // Multipart and streamed uploads may not declare their size. Check the
    // provider's logical quota after counting the actual bytes, too. The
    // host free-space figure is not checked here because writing the object
    // has already reduced it.
    if (provider.capacity !== null) {
      const usage = await prisma.file.aggregate({ where: { storageProviderId: provider.id }, _sum: { size: true } });
      if (Number(usage._sum.size ?? 0) + size > Number(provider.capacity)) throw new AppError('quota_exceeded');
    }
    await assertUploadQuota(input.zone, input.apiKeyId, size);
  } catch (err) {
    await cleanupNew();
    throw err;
  }

  // Duplicate detection: reuse an existing stored object with the same content.
  if (settings.uploads.deduplicate) {
    const dup = await prisma.file.findFirst({
      where: { sha256, size: BigInt(size), storageProviderId: provider.id, status: 'READY' },
      select: { storageKey: true },
    });
    if (dup && dup.storageKey !== storageKey) {
      await cleanupNew();
      return { provider, storageKey: dup.storageKey, sha256, size, sniff, reused: true, cleanup: async () => undefined };
    }
  }
  return { provider, storageKey, sha256, size, sniff, reused: false, cleanup: cleanupNew };
}

export async function ingestFile(input: IngestInput): Promise<ReturnType<typeof serializeFile>> {
  const settings = await getSettings();
  const { name, maxSize, zone } = await assertUploadAllowed(input.filename, { folderId: input.folderId, apiKeyId: input.apiKeyId, declaredSize: input.declaredSize });
  const prisma = getPrisma();
  const fileId = newId('file');
  const stored = await storeUpload({
    stream: input.stream,
    name,
    objectId: fileId,
    maxSize,
    zone,
    declaredSize: input.declaredSize,
    expectedSha256: input.expectedSha256,
    storageProviderId: input.storageProviderId,
    apiKeyId: input.apiKeyId,
  });

  const scanRequired = settings.uploads.requireMalwareScan && Boolean(scannerFromEnv(env().CLAMAV_HOST, env().CLAMAV_PORT));
  const visibility = input.visibility ?? (await inheritedVisibility(input.folderId)) ?? zone?.defaultVisibility ?? settings.files.defaultVisibility;
  const slug = await uniqueFileSlug(input.folderId, name);
  const status = scanRequired && !stored.reused ? 'SCANNING' : 'READY';

  let file;
  try {
    file = await prisma.file.create({
      data: {
        id: fileId,
        name,
        slug,
        folderId: input.folderId,
        mimeType: stored.sniff.mime,
        extension: extensionOf(name),
        size: BigInt(stored.size),
        sha256: stored.sha256,
        storageProviderId: stored.provider.id,
        storageKey: stored.storageKey,
        visibility,
        status,
        cacheControl: input.cacheControl ?? null,
        forceDownload: input.forceDownload ?? (settings.files.forceDownloadActiveContent && isActiveContentType(stored.sniff.mime)),
        width: stored.sniff.width ?? null,
        height: stored.sniff.height ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        cacheTags: normalizeTags(input.cacheTags),
        expiresAt: input.expiresAt ?? null,
        uploadedById: input.userId,
        uploadedByApiKeyId: input.apiKeyId,
        scannedAt: stored.reused && scanRequired ? new Date() : null,
      },
      include: FILE_INCLUDE,
    });
  } catch (err) {
    await stored.cleanup();
    throw err;
  }

  await audit(input.actor, 'FILE_UPLOAD', { type: 'file', id: file.id }, { name, size: stored.size, mime: stored.sniff.mime, sha256: stored.sha256, folder_id: input.folderId, zone_id: zone?.id, deduplicated: stored.reused });
  // Background processing: malware scan (if required), media metadata, renditions, replication.
  await enqueueFileProcessing(file.id);
  const serialized = serializeFile(file);
  if (status === 'READY') await emitWebhookEvent('file.uploaded', { file: serialized }, { projectId: zone?.projectId });
  return serialized;
}

/**
 * Replaces the content of an existing file. The current content becomes a FileVersion
 * (revision history), the file keeps its id and URLs, and edge caches are purged.
 */
export async function replaceFileContent(
  file: File,
  input: { stream: Readable; filename?: string; declaredSize?: number; expectedSha256?: string | null; userId: string | null; apiKeyId: string | null; actor: AuditContext },
): Promise<File> {
  const settings = await getSettings();
  const { name, maxSize, zone } = await assertUploadAllowed(input.filename ?? file.name, { folderId: file.folderId, apiKeyId: input.apiKeyId, declaredSize: input.declaredSize });
  const prisma = getPrisma();
  const stored = await storeUpload({
    stream: input.stream,
    name,
    objectId: newId('fileVersion'),
    maxSize,
    zone,
    declaredSize: input.declaredSize,
    expectedSha256: input.expectedSha256,
    apiKeyId: input.apiKeyId,
  });
  const scanRequired = settings.uploads.requireMalwareScan && Boolean(scannerFromEnv(env().CLAMAV_HOST, env().CLAMAV_PORT));
  let updated: File;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.fileVersion.create({
        data: {
          id: newId('fileVersion'),
          fileId: file.id,
          version: file.version,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          storageProviderId: file.storageProviderId,
          storageKey: file.storageKey,
          width: file.width,
          height: file.height,
          durationSeconds: file.durationSeconds,
          createdById: file.uploadedById,
          createdByApiKeyId: file.uploadedByApiKeyId,
          uploadedAt: file.updatedAt,
        },
      });
      return tx.file.update({
        where: { id: file.id },
        data: {
          name,
          slug: name === file.name ? file.slug : await uniqueFileSlug(file.folderId, name, file.id),
          extension: extensionOf(name),
          mimeType: stored.sniff.mime,
          size: BigInt(stored.size),
          sha256: stored.sha256,
          storageProviderId: stored.provider.id,
          storageKey: stored.storageKey,
          width: stored.sniff.width ?? null,
          height: stored.sniff.height ?? null,
          durationSeconds: null,
          version: { increment: 1 },
          // Keep serving while metadata / renditions are rebuilt; only a required malware scan takes the file offline.
          status: scanRequired && !stored.reused ? 'SCANNING' : file.status,
          uploadedById: input.userId,
          uploadedByApiKeyId: input.apiKeyId,
        },
      });
    });
  } catch (err) {
    await stored.cleanup();
    throw err;
  }
  // Derived content (variants, renditions, replicas) belongs to the old revision.
  await purgeVariants(file.id);
  await prisma.fileReplica.updateMany({ where: { fileId: file.id }, data: { status: 'PENDING', sha256: null } });
  await audit(input.actor, 'FILE_VERSION_UPLOAD', { type: 'file', id: file.id }, { version: updated.version, previous_sha256: file.sha256, sha256: stored.sha256, size: stored.size });
  await enqueueFileProcessing(file.id, { reprocess: true });
  // Same URLs now serve new content: invalidate edge caches.
  await autoPurgeFiles([file], 'content replaced');
  return updated;
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const t of tags) {
    const clean = t.trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9:._/-]{0,99}$/.test(clean)) out.add(clean);
    if (out.size >= 32) break;
  }
  return [...out];
}
