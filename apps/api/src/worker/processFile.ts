import { parseStream } from 'music-metadata';
import { imageSize } from 'image-size';
import { getPrisma } from '@cdn/database';
import { env } from '../config/env.js';
import { audit, securityEvent } from '../lib/audit.js';
import { baseLogger } from '../lib/logger.js';
import { scannerFromEnv } from '../lib/scanner.js';
import { driverForId } from '../lib/storageRegistry.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';

const log = baseLogger.child({ worker: 'file-processing' });

async function streamToBuffer(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(b);
    len += b.length;
    if (len >= max) break;
  }
  (stream as unknown as { destroy?: () => void }).destroy?.();
  return Buffer.concat(chunks);
}

/**
 * Background processing for a new file:
 *  1. Malware scan (when the file is in SCANNING state). Infected → QUARANTINED, never served.
 *  2. Media metadata (image dimensions, audio/video duration) — best effort, never blocks READY.
 */
export async function processFile(fileId: string): Promise<void> {
  const prisma = getPrisma();
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file) return;
  const { driver } = await driverForId(file.storageProviderId);

  if (file.status === 'SCANNING') {
    const e = env();
    const scanner = scannerFromEnv(e.CLAMAV_HOST, e.CLAMAV_PORT);
    if (!scanner) throw new Error('File requires scanning but no scanner is configured');
    const result = await scanner.scan(await driver.get(file.storageKey));
    if (!result.clean) {
      await prisma.file.update({ where: { id: file.id }, data: { status: 'QUARANTINED', statusReason: `Malware detected: ${result.signature}`, scannedAt: new Date() } });
      await securityEvent('MALWARE_DETECTED', { severity: 'critical', userId: file.uploadedById, apiKeyId: file.uploadedByApiKeyId, details: { file_id: file.id, name: file.name, signature: result.signature } });
      await audit({ actorType: 'system', actorLabel: 'malware-scanner' }, 'FILE_QUARANTINED', { type: 'file', id: file.id }, { signature: result.signature, engine: result.engine });
      await emitWebhookEvent('upload.failed', { file_id: file.id, filename: file.name, error: { code: 'malware_detected' } });
      log.warn({ file_id: file.id, signature: result.signature }, 'file quarantined');
      return;
    }
    await prisma.file.update({ where: { id: file.id }, data: { scannedAt: new Date(), status: 'PROCESSING' } });
  }

  // Media metadata (best effort)
  const data: { width?: number; height?: number; durationSeconds?: number } = {};
  try {
    if (file.mimeType.startsWith('audio/') || file.mimeType.startsWith('video/')) {
      const meta = await parseStream(await driver.get(file.storageKey), { mimeType: file.mimeType, size: Number(file.size) }, { duration: true, skipCovers: true });
      if (meta.format.duration) data.durationSeconds = Math.round(meta.format.duration * 1000) / 1000;
      const video = meta.format as { width?: number; height?: number };
      if (video.width && video.height) {
        data.width = video.width;
        data.height = video.height;
      }
    } else if (file.mimeType.startsWith('image/') && (!file.width || !file.height)) {
      const head = await streamToBuffer(await driver.get(file.storageKey, { start: 0, end: Math.min(Number(file.size), 2 * 1024 * 1024) - 1 }), 2 * 1024 * 1024);
      const dim = imageSize(head);
      if (dim.width && dim.height) {
        data.width = dim.width;
        data.height = dim.height;
      }
    }
  } catch (err) {
    log.debug({ err, file_id: file.id }, 'metadata extraction skipped');
  }

  const wasPending = file.status === 'SCANNING' || file.status === 'PROCESSING';
  const updated = await prisma.file.update({
    where: { id: file.id },
    data: { ...data, ...(wasPending ? { status: 'READY', statusReason: null } : {}) },
    include: FILE_INCLUDE,
  });
  if (wasPending) await emitWebhookEvent('file.uploaded', { file: serializeFile(updated) });
}

/** Called when all retries are exhausted. */
export async function markProcessingFailed(fileId: string, reason: string): Promise<void> {
  const prisma = getPrisma();
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || file.status === 'READY' || file.status === 'QUARANTINED') return;
  await prisma.file.update({ where: { id: fileId }, data: { status: 'FAILED', statusReason: reason.slice(0, 500) } });
  await emitWebhookEvent('upload.failed', { file_id: fileId, filename: file.name, error: { code: 'processing_failed' } });
}
