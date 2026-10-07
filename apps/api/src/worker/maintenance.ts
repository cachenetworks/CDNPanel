import fs from 'node:fs/promises';
import { getPrisma } from '@cdn/database';
import { newId } from '@cdn/shared';
import { getSettings } from '../lib/settings.js';
import { baseLogger } from '../lib/logger.js';
import { uploadTmpDir } from '../routes/uploads.js';

const log = baseLogger.child({ worker: 'maintenance' });

/** Expires abandoned chunked uploads and removes their temporary chunks. */
export async function cleanupExpiredUploads(): Promise<number> {
  const prisma = getPrisma();
  const expired = await prisma.upload.findMany({
    where: { OR: [{ status: 'PENDING', expiresAt: { lt: new Date() } }, { status: { in: ['FAILED', 'ABORTED', 'COMPLETED'] }, updatedAt: { lt: new Date(Date.now() - 86_400_000) } }] },
    take: 500,
  });
  for (const u of expired) {
    await fs.rm(uploadTmpDir(u.id), { recursive: true, force: true }).catch(() => undefined);
    if (u.status === 'PENDING') await prisma.upload.update({ where: { id: u.id }, data: { status: 'EXPIRED' } });
    else await prisma.upload.delete({ where: { id: u.id } });
  }
  // Uploads stuck in COMPLETING (e.g. process crashed mid-assembly) for more than an hour.
  await prisma.upload.updateMany({ where: { status: 'COMPLETING', updatedAt: { lt: new Date(Date.now() - 3_600_000) } }, data: { status: 'FAILED', error: 'interrupted' } });
  if (expired.length) log.info({ count: expired.length }, 'cleaned up uploads');
  return expired.length;
}

/** Removes expired/revoked sessions and used one-time tokens. */
export async function expireSessions(): Promise<void> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] } });
  await prisma.userToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] } });
}

/**
 * Rolls raw FileRequest rows up into AnalyticsDaily for the given UTC day, per dimension.
 * Idempotent: re-running recomputes the same values.
 */
export async function aggregateDay(day: Date): Promise<void> {
  const prisma = getPrisma();
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  const dims: { name: string; expr: string; filter?: string }[] = [
    { name: 'total', expr: `''` },
    { name: 'file', expr: `"fileId"`, filter: `"fileId" IS NOT NULL` },
    { name: 'api_key', expr: `"apiKeyId"`, filter: `"apiKeyId" IS NOT NULL` },
    { name: 'mime', expr: `coalesce("mimeType", '')`, filter: `"kind" = 'delivery'` },
    { name: 'country', expr: `coalesce("country", 'Unknown')` },
    { name: 'status', expr: `"statusCode"::text` },
  ];
  for (const d of dims) {
    // Expressions above are static strings (never user input), so building SQL here is safe.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AnalyticsDaily" ("id", "date", "dimension", "dimensionId", "requests", "downloads", "bytes", "errors", "uploads", "avgMs", "updatedAt")
       SELECT 'agg_' || md5($3 || ':' || ${d.expr} || ':' || $1::text), ($1::timestamptz AT TIME ZONE 'UTC')::date, $3, ${d.expr},
              count(*),
              count(*) FILTER (WHERE "kind" = 'delivery' AND "method" = 'GET' AND ("statusCode" = 200 OR "cacheStatus" = 'range-start')),
              coalesce(sum("bytesSent"), 0),
              count(*) FILTER (WHERE "statusCode" >= 400),
              0,
              coalesce(avg("responseMs"), 0),
              (now() AT TIME ZONE 'UTC')
       FROM "FileRequest"
       WHERE "timestamp" >= ($1::timestamptz AT TIME ZONE 'UTC') AND "timestamp" < ($2::timestamptz AT TIME ZONE 'UTC') ${d.filter ? `AND ${d.filter}` : ''}
       GROUP BY ${d.expr}
       ON CONFLICT ("date", "dimension", "dimensionId") DO UPDATE SET
         "requests" = EXCLUDED."requests", "downloads" = EXCLUDED."downloads", "bytes" = EXCLUDED."bytes",
         "errors" = EXCLUDED."errors", "avgMs" = EXCLUDED."avgMs", "updatedAt" = (now() AT TIME ZONE 'UTC')`,
      start,
      end,
      d.name,
    );
  }
  const uploads = await prisma.file.count({ where: { createdAt: { gte: start, lt: end } } });
  await prisma.analyticsDaily.upsert({
    where: { date_dimension_dimensionId: { date: start, dimension: 'total', dimensionId: '' } },
    create: { id: newId('request').replace('req_', 'agg_'), date: start, dimension: 'total', dimensionId: '', uploads: BigInt(uploads) },
    update: { uploads: BigInt(uploads) },
  });
}

export async function aggregateAnalytics(): Promise<void> {
  const now = new Date();
  await aggregateDay(new Date(now.getTime() - 86_400_000));
  await aggregateDay(now);
}

/** Applies retention settings. Raw request rows are aggregated before they are deleted. */
export async function pruneRetention(): Promise<void> {
  const prisma = getPrisma();
  const { retention } = await getSettings();
  const requestCutoff = new Date(Date.now() - retention.requestLogDays * 86_400_000);
  const oldest = await prisma.fileRequest.findFirst({ where: { timestamp: { lt: requestCutoff } }, orderBy: { timestamp: 'asc' }, select: { timestamp: true } });
  if (oldest) {
    for (let d = new Date(oldest.timestamp); d < requestCutoff; d = new Date(d.getTime() + 86_400_000)) await aggregateDay(d);
  }
  const requests = await prisma.fileRequest.deleteMany({ where: { timestamp: { lt: requestCutoff } } });
  const events = await prisma.securityEvent.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - retention.securityEventDays * 86_400_000) } } });
  const deliveries = await prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - retention.webhookDeliveryDays * 86_400_000) } } });
  // Audit rows are protected by a trigger; pruning must explicitly opt in within a transaction.
  const auditCutoff = new Date(Date.now() - retention.auditLogDays * 86_400_000);
  const [, audits] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('cdn.audit_prune', 'on', true)`,
    prisma.auditLog.deleteMany({ where: { timestamp: { lt: auditCutoff } } }),
  ]);
  log.info({ requests: requests.count, security_events: events.count, webhook_deliveries: deliveries.count, audit_logs: audits.count }, 'retention pruning complete');
}
