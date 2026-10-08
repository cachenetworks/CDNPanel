import { getPrisma } from '@cdn/database';
import { anonymizeIp } from './ip.js';
import { getSettings } from './settings.js';
import { baseLogger } from './logger.js';

/**
 * Buffered analytics writer. Delivery requests are appended to an in-memory buffer and
 * flushed in batches so that file delivery never waits on an analytics INSERT.
 */
export interface RequestRecord {
  timestamp: Date;
  fileId?: string | null;
  folderId?: string | null;
  apiKeyId?: string | null;
  method: string;
  route: string;
  statusCode: number;
  bytesSent: number;
  responseMs: number;
  mimeType?: string | null;
  country?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  kind: 'delivery' | 'api' | 'transform' | 'media' | 'share';
  cacheStatus?: string | null;
  zoneId?: string | null;
  projectId?: string | null;
  cpuMs?: number | null;
}

const MAX_BUFFER = 5000;
const FLUSH_INTERVAL_MS = 2000;

let buffer: RequestRecord[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

export function recordRequest(rec: RequestRecord): void {
  if (buffer.length >= MAX_BUFFER * 2) return; // shed load rather than exhaust memory
  buffer.push(rec);
  if (buffer.length >= MAX_BUFFER) void flushRequests();
  if (!timer) {
    timer = setInterval(() => void flushRequests(), FLUSH_INTERVAL_MS);
    timer.unref();
  }
}

export async function flushRequests(): Promise<void> {
  if (flushing) return flushing;
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  flushing = (async () => {
    try {
      const settings = await getSettings();
      if (!settings.analytics.enabled) return;
      const rows = batch
        .filter((r) => r.kind !== 'api' || settings.analytics.trackApiRequests)
        .map((r) => ({
          timestamp: r.timestamp,
          fileId: r.fileId ?? null,
          folderId: r.folderId ?? null,
          apiKeyId: r.apiKeyId ?? null,
          method: r.method,
          route: r.route.slice(0, 200),
          statusCode: r.statusCode,
          bytesSent: BigInt(Math.max(0, Math.floor(r.bytesSent))),
          responseMs: Math.max(0, Math.round(r.responseMs)),
          mimeType: r.mimeType ?? null,
          country: r.country ?? null,
          ip: !r.ip || settings.analytics.ipStorage === 'none' ? null : settings.analytics.ipStorage === 'full' ? r.ip : anonymizeIp(r.ip),
          userAgent: settings.analytics.storeUserAgent ? (r.userAgent?.slice(0, 300) ?? null) : null,
          kind: r.kind,
          cacheStatus: r.cacheStatus ?? null,
          zoneId: r.zoneId ?? null,
          projectId: r.projectId ?? null,
          cpuMs: r.cpuMs ?? null,
        }));
      if (rows.length > 0) {
        const prisma = getPrisma();
        await prisma.fileRequest.createMany({ data: rows });
        // Maintain per-file counters for successful deliveries.
        const perFile = new Map<string, { downloads: number; bytes: number; last: Date }>();
        for (const r of rows) {
          if (r.kind === 'api' || !r.fileId || r.method === 'HEAD' || r.statusCode >= 400 || r.statusCode === 304) continue;
          const agg = perFile.get(r.fileId) ?? { downloads: 0, bytes: 0, last: r.timestamp };
          // Only count a "download" for full responses or the first range chunk.
          agg.downloads += (r.kind === 'delivery' || r.kind === 'share') && (r.statusCode === 200 || r.cacheStatus === 'range-start') ? 1 : 0;
          agg.bytes += Number(r.bytesSent);
          if (r.timestamp > agg.last) agg.last = r.timestamp;
          perFile.set(r.fileId, agg);
        }
        for (const [fileId, agg] of perFile) {
          await prisma.file
            .updateMany({
              where: { id: fileId },
              data: { downloadCount: { increment: agg.downloads }, bandwidthBytes: { increment: agg.bytes }, lastAccessedAt: agg.last },
            })
            .catch(() => undefined);
        }
      }
    } catch (err) {
      baseLogger.error({ err, dropped: batch.length }, 'failed to flush request analytics');
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export async function stopRequestLog(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await flushRequests();
}
