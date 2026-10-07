import { createHash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { getPrisma, Prisma, type File, type Visibility } from '@cdn/database';
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
import { sniffContent, SNIFF_BYTES } from '../lib/sniff.js';
import { inheritedVisibility } from '../lib/folders.js';
import { enqueueFileProcessing } from '../lib/queue.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { audit, type AuditContext } from '../lib/audit.js';
import { scannerFromEnv } from '../lib/scanner.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';

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
  expectedSha256?: string | null;
  userId: string | null;
  apiKeyId: string | null;
  actor: AuditContext;
  /** Storage provider override (chunked uploads pin the provider at init). */
  storageProviderId?: string;
}

export async function assertUploadAllowed(filename: string, declaredSize?: number): Promise<{ name: string; maxSize: number }> {
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
  const maxSize = Math.min(settings.uploads.maxFileSize, env().MAX_UPLOAD_SIZE);
  if (declaredSize !== undefined && declaredSize > maxSize) throw new AppError('file_too_large');
  if (settings.uploads.quotaBytes !== null && declaredSize !== undefined) {
    const used = await storageUsed();
    if (used + declaredSize > settings.uploads.quotaBytes) throw new AppError('quota_exceeded');
  }
  if (settings.uploads.requireMalwareScan && !env().CLAMAV_HOST) {
    throw new AppError('service_unavailable', 'Malware scanning is required but no scanner is configured.');
  }
  return { name, maxSize };
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

export async function ingestFile(input: IngestInput): Promise<ReturnType<typeof serializeFile>> {
  const settings = await getSettings();
  const { name, maxSize } = await assertUploadAllowed(input.filename, input.declaredSize);
  const prisma = getPrisma();
  const provider = input.storageProviderId
    ? await prisma.storageProvider.findUniqueOrThrow({ where: { id: input.storageProviderId } })
    : await uploadProvider(settings.uploads.storageProviderId);
  const driver = driverFor(provider);
  const fileId = newId('file');
  const storageKey = objectKeyForFile(fileId);

  const inspector = new Inspector(maxSize);
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
  if ((input.stream as { truncated?: boolean }).truncated || inspector.bytes > maxSize) {
    await driver.delete(storageKey).catch(() => undefined);
    throw new AppError('file_too_large');
  }

  const sha256 = inspector.hash.digest('hex');
  const size = inspector.bytes;
  const cleanup = () => driver.delete(storageKey).catch(() => undefined);

  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
    await cleanup();
    throw new AppError('checksum_mismatch', undefined, { expected: input.expectedSha256.toLowerCase(), actual: sha256 });
  }
  if (input.declaredSize !== undefined && input.declaredSize !== size) {
    await cleanup();
    throw new AppError('validation_failed', `Received ${size} bytes but ${input.declaredSize} were declared.`);
  }

  const sniff = await sniffContent(inspector.head(), name);
  if (settings.uploads.allowedMimeTypes.length > 0 && !settings.uploads.allowedMimeTypes.some((p) => mimeMatches(p, sniff.mime))) {
    await cleanup();
    throw new AppError('unsupported_file_type', `Files of type ${sniff.mime} are not allowed.`);
  }

  if (settings.uploads.quotaBytes !== null) {
    const used = await storageUsed();
    if (used + size > settings.uploads.quotaBytes) {
      await cleanup();
      throw new AppError('quota_exceeded');
    }
  }

  // Duplicate detection: reuse an existing stored object with the same content.
  let finalKey = storageKey;
  if (settings.uploads.deduplicate) {
    const dup = await prisma.file.findFirst({
      where: { sha256, size: BigInt(size), storageProviderId: provider.id, status: 'READY' },
      select: { storageKey: true },
    });
    if (dup) {
      await cleanup();
      finalKey = dup.storageKey;
    }
  }

  const scanRequired = settings.uploads.requireMalwareScan && Boolean(scannerFromEnv(env().CLAMAV_HOST, env().CLAMAV_PORT));
  const visibility = input.visibility ?? (await inheritedVisibility(input.folderId)) ?? settings.files.defaultVisibility;
  const slug = await uniqueFileSlug(input.folderId, name);
  const reusedVerifiedObject = finalKey !== storageKey;
  const status = scanRequired && !reusedVerifiedObject ? 'SCANNING' : 'READY';

  let file: File;
  try {
    file = await prisma.file.create({
      data: {
        id: fileId,
        name,
        slug,
        folderId: input.folderId,
        mimeType: sniff.mime,
        extension: extensionOf(name),
        size: BigInt(size),
        sha256,
        storageProviderId: provider.id,
        storageKey: finalKey,
        visibility,
        status,
        cacheControl: input.cacheControl ?? null,
        forceDownload: input.forceDownload ?? (settings.files.forceDownloadActiveContent && isActiveContentType(sniff.mime)),
        width: sniff.width ?? null,
        height: sniff.height ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        uploadedById: input.userId,
        uploadedByApiKeyId: input.apiKeyId,
        scannedAt: reusedVerifiedObject && scanRequired ? new Date() : null,
      },
      include: FILE_INCLUDE,
    });
  } catch (err) {
    if (finalKey === storageKey) await cleanup();
    throw err;
  }

  await audit(input.actor, 'FILE_UPLOAD', { type: 'file', id: file.id }, { name, size, mime: sniff.mime, sha256, folder_id: input.folderId, deduplicated: reusedVerifiedObject });
  // Background processing: malware scan (if required) and media metadata extraction.
  await enqueueFileProcessing(file.id);
  const serialized = serializeFile(file);
  if (status === 'READY') await emitWebhookEvent('file.uploaded', { file: serialized });
  return serialized;
}
