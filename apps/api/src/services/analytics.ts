import { getPrisma, Prisma } from '@cdn/database';
import { AppError } from '@cdn/shared';

export type Period = '24h' | '7d' | '30d' | '90d' | 'custom';

export interface Range {
  from: Date;
  to: Date;
  unit: 'hour' | 'day';
}

export function resolveRange(period: Period, from?: Date, to?: Date): Range {
  const now = new Date();
  if (period === 'custom') {
    if (!from || !to) throw new AppError('validation_failed', 'from and to are required for a custom period.');
    if (from >= to) throw new AppError('validation_failed', 'from must be before to.');
    if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new AppError('validation_failed', 'The maximum range is 400 days.');
    return { from, to, unit: to.getTime() - from.getTime() <= 3 * 86_400_000 ? 'hour' : 'day' };
  }
  const hours = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[period];
  return { from: new Date(now.getTime() - hours * 3_600_000), to: now, unit: period === '24h' ? 'hour' : 'day' };
}

export interface Filter {
  fileId?: string;
  apiKeyId?: string;
}

function filterSql(f: Filter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.fileId) parts.push(Prisma.sql`AND "fileId" = ${f.fileId}`);
  if (f.apiKeyId) parts.push(Prisma.sql`AND "apiKeyId" = ${f.apiKeyId}`);
  return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
}

// Historical rows have no trafficType; their disposition cannot be recovered safely.
const SUCCESSFUL_INTERACTION = Prisma.sql`("method" = 'GET' AND ("statusCode" = 200 OR "cacheStatus" = 'range-start'))`;
const DOWNLOAD_COND = Prisma.sql`("trafficType" = 'download' AND ${SUCCESSFUL_INTERACTION})`;
const VIEW_COND = Prisma.sql`("trafficType" = 'view' AND ${SUCCESSFUL_INTERACTION})`;
const CLICK_COND = Prisma.sql`("trafficType" = 'click' AND "method" = 'GET' AND "statusCode" = 200)`;

type Row = Record<string, unknown>;

/**
 * Columns are `timestamp without time zone` holding UTC. Bind JS Dates as timestamptz and convert
 * explicitly, so results never depend on the database server's TimeZone setting.
 */
const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? 0 : Number(v));

export async function timeSeries(range: Range, filter: Filter = {}) {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT date_trunc(${range.unit}, "timestamp") AS bucket,
           count(*) AS requests,
           count(*) FILTER (WHERE ${DOWNLOAD_COND}) AS downloads,
           count(*) FILTER (WHERE ${VIEW_COND}) AS views,
           count(*) FILTER (WHERE ${CLICK_COND}) AS clicks,
           coalesce(sum("bytesSent"), 0) AS bytes,
           count(*) FILTER (WHERE "statusCode" >= 400) AS errors,
           count(*) FILTER (WHERE "cacheStatus" IN ('revalidated', 'variant-hit')) AS cache_hits,
           coalesce(avg("responseMs"), 0) AS avg_ms
    FROM "FileRequest"
    WHERE "timestamp" >= ${utc(range.from)} AND "timestamp" <= ${utc(range.to)} ${filterSql(filter)}
    GROUP BY bucket ORDER BY bucket`;
  const uploads = filter.apiKeyId || filter.fileId
    ? []
    : await prisma.$queryRaw<Row[]>`
        SELECT date_trunc(${range.unit}, "createdAt") AS bucket, count(*) AS uploads
        FROM "File" WHERE "createdAt" >= ${utc(range.from)} AND "createdAt" <= ${utc(range.to)}
        GROUP BY bucket`;
  // Days older than the raw-request retention window come from the daily rollups.
  const rollups =
    range.unit === 'day' && !filter.apiKeyId
      ? await prisma.analyticsDaily.findMany({
          where: { dimension: filter.fileId ? 'file' : 'total', dimensionId: filter.fileId ?? '', date: { gte: startOfDay(range.from), lte: range.to } },
        })
      : [];

  const map = new Map<number, { t: string; requests: number; downloads: number; views: number; clicks: number; bandwidth: number; errors: number; cache_hits: number; avg_ms: number; uploads: number }>();
  const step = range.unit === 'hour' ? 3_600_000 : 86_400_000;
  const start = range.unit === 'hour' ? Math.floor(range.from.getTime() / step) * step : startOfDay(range.from).getTime();
  for (let t = start; t <= range.to.getTime(); t += step) {
    map.set(t, { t: new Date(t).toISOString(), requests: 0, downloads: 0, views: 0, clicks: 0, bandwidth: 0, errors: 0, cache_hits: 0, avg_ms: 0, uploads: 0 });
  }
  for (const r of rows) {
    const key = (r.bucket as Date).getTime();
    const e = map.get(key);
    if (!e) continue;
    Object.assign(e, { requests: num(r.requests), downloads: num(r.downloads), views: num(r.views), clicks: num(r.clicks), bandwidth: num(r.bytes), errors: num(r.errors), cache_hits: num(r.cache_hits), avg_ms: Math.round(num(r.avg_ms) * 10) / 10 });
  }
  for (const r of rollups) {
    const e = map.get(r.date.getTime());
    if (e && e.requests === 0) {
      Object.assign(e, { requests: num(r.requests), downloads: num(r.downloads), views: num(r.views), clicks: num(r.clicks), bandwidth: num(r.bytes), errors: num(r.errors), avg_ms: r.avgMs });
    }
  }
  for (const r of uploads) {
    const e = map.get((r.bucket as Date).getTime());
    if (e) e.uploads = num(r.uploads);
  }
  return [...map.values()];
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function totals(range: Range, filter: Filter = {}) {
  const [r] = await getPrisma().$queryRaw<Row[]>`
    SELECT count(*) AS requests,
           count(*) FILTER (WHERE ${DOWNLOAD_COND}) AS downloads,
           count(*) FILTER (WHERE ${VIEW_COND}) AS views,
           count(*) FILTER (WHERE ${CLICK_COND}) AS clicks,
           coalesce(sum("bytesSent"), 0) AS bytes,
           count(*) FILTER (WHERE "statusCode" >= 400) AS errors,
           count(*) FILTER (WHERE "kind" = 'api' AND "statusCode" >= 400) AS api_errors,
           count(*) FILTER (WHERE "cacheStatus" IN ('revalidated', 'variant-hit')) AS cache_hits,
           count(*) FILTER (WHERE "kind" <> 'api') AS delivery_requests,
           coalesce(avg("responseMs"), 0) AS avg_ms,
           coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseMs"), 0) AS p95_ms
    FROM "FileRequest"
    WHERE "timestamp" >= ${utc(range.from)} AND "timestamp" <= ${utc(range.to)} ${filterSql(filter)}`;
  const deliveries = num(r?.delivery_requests);
  return {
    requests: num(r?.requests),
    downloads: num(r?.downloads),
    views: num(r?.views),
    clicks: num(r?.clicks),
    bandwidth: num(r?.bytes),
    errors: num(r?.errors),
    api_errors: num(r?.api_errors),
    cache_hits: num(r?.cache_hits),
    cache_hit_ratio: deliveries ? Math.round((num(r?.cache_hits) / deliveries) * 1000) / 1000 : 0,
    avg_response_ms: Math.round(num(r?.avg_ms) * 10) / 10,
    p95_response_ms: Math.round(num(r?.p95_ms) * 10) / 10,
  };
}

export async function breakdowns(range: Range, filter: Filter = {}) {
  const prisma = getPrisma();
  const where = Prisma.sql`"timestamp" >= ${utc(range.from)} AND "timestamp" <= ${utc(range.to)} ${filterSql(filter)}`;
  const [statusCodes, countries, mimes, topFiles, topKeys, topFolders] = await Promise.all([
    prisma.$queryRaw<Row[]>`SELECT "statusCode" AS code, count(*) AS count FROM "FileRequest" WHERE ${where} GROUP BY "statusCode" ORDER BY count DESC LIMIT 20`,
    prisma.$queryRaw<Row[]>`SELECT coalesce("country", 'Unknown') AS country, count(*) AS requests, coalesce(sum("bytesSent"),0) AS bytes FROM "FileRequest" WHERE ${where} GROUP BY 1 ORDER BY requests DESC LIMIT 15`,
    prisma.$queryRaw<Row[]>`SELECT coalesce("mimeType", 'n/a') AS mime, count(*) AS requests, coalesce(sum("bytesSent"),0) AS bytes FROM "FileRequest" WHERE ${where} AND "kind" <> 'api' GROUP BY 1 ORDER BY bytes DESC LIMIT 15`,
    prisma.$queryRaw<Row[]>`SELECT r."fileId" AS id, f."name" AS name, count(*) FILTER (WHERE ${DOWNLOAD_COND}) AS downloads, count(*) FILTER (WHERE ${VIEW_COND}) AS views, count(*) FILTER (WHERE ${CLICK_COND}) AS clicks, count(*) AS requests, coalesce(sum(r."bytesSent"),0) AS bytes
      FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId" WHERE r."timestamp" >= ${utc(range.from)} AND r."timestamp" <= ${utc(range.to)} ${filterSql(filter)}
      GROUP BY r."fileId", f."name" ORDER BY bytes DESC LIMIT 10`,
    prisma.$queryRaw<Row[]>`SELECT r."apiKeyId" AS id, k."name" AS name, k."prefix" AS prefix, count(*) AS requests, count(*) FILTER (WHERE r."statusCode" >= 400) AS errors, coalesce(sum(r."bytesSent"),0) AS bytes
      FROM "FileRequest" r JOIN "ApiKey" k ON k."id" = r."apiKeyId" WHERE r."timestamp" >= ${utc(range.from)} AND r."timestamp" <= ${utc(range.to)} ${filterSql(filter)}
      GROUP BY r."apiKeyId", k."name", k."prefix" ORDER BY requests DESC LIMIT 10`,
    prisma.$queryRaw<Row[]>`SELECT r."folderId" AS id, coalesce(fo."path", '/') AS path, count(*) AS requests, coalesce(sum(r."bytesSent"),0) AS bytes
      FROM "FileRequest" r LEFT JOIN "Folder" fo ON fo."id" = r."folderId" WHERE r."kind" <> 'api' AND r."timestamp" >= ${utc(range.from)} AND r."timestamp" <= ${utc(range.to)} ${filterSql(filter)}
      GROUP BY r."folderId", fo."path" ORDER BY bytes DESC LIMIT 10`,
  ]);
  return {
    status_codes: statusCodes.map((r) => ({ code: num(r.code), count: num(r.count) })),
    countries: countries.map((r) => ({ country: String(r.country), requests: num(r.requests), bandwidth: num(r.bytes) })),
    mime_types: mimes.map((r) => ({ mime_type: String(r.mime), requests: num(r.requests), bandwidth: num(r.bytes) })),
    top_files: topFiles.map((r) => ({ id: String(r.id), name: String(r.name), downloads: num(r.downloads), views: num(r.views), clicks: num(r.clicks), requests: num(r.requests), bandwidth: num(r.bytes) })),
    top_api_keys: topKeys.map((r) => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), requests: num(r.requests), errors: num(r.errors), bandwidth: num(r.bytes) })),
    top_folders: topFolders.map((r) => ({ id: r.id ? String(r.id) : null, path: String(r.path), requests: num(r.requests), bandwidth: num(r.bytes) })),
  };
}

export async function recentErrors(range: Range, limit = 20) {
  const rows = await getPrisma().fileRequest.findMany({
    where: { timestamp: { gte: range.from, lte: range.to }, statusCode: { gte: 400 } },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    timestamp: r.timestamp.toISOString(),
    method: r.method,
    route: r.route,
    status: r.statusCode,
    file_id: r.fileId,
    api_key_id: r.apiKeyId,
    ip: r.ip,
    kind: r.kind,
  }));
}

export async function bandwidthSince(from: Date): Promise<number> {
  const prisma = getPrisma();
  const raw = await prisma.fileRequest.aggregate({ _sum: { bytesSent: true }, where: { timestamp: { gte: from } } });
  // Add rolled-up days that are older than the oldest raw row (pruned by retention).
  const oldest = await prisma.fileRequest.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } });
  let rolled = 0;
  if (oldest && oldest.timestamp > from) {
    const agg = await prisma.analyticsDaily.aggregate({ _sum: { bytes: true }, where: { dimension: 'total', date: { gte: startOfDay(from), lt: startOfDay(oldest.timestamp) } } });
    rolled = num(agg._sum.bytes);
  }
  return num(raw._sum.bytesSent) + rolled;
}
