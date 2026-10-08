import { getPrisma, Prisma, type Quota } from '@cdn/database';
import { AppError } from '@cdn/shared';
import { audit, securityEvent } from '../lib/audit.js';
import { baseLogger } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { getZones, type ZoneWithRelations } from '../lib/zones.js';

/**
 * Usage metering, quotas and cost estimates.
 *
 * Metrics (per calendar month in UTC, except storage which is a point-in-time total):
 *   storage_bytes – bytes stored (current revisions + previous revisions + recycle bin)
 *   egress_bytes  – bytes delivered (CDN delivery, transformations, media, share downloads)
 *   requests      – delivery requests
 *   transforms    – image variants generated (cache misses; the CPU-heavy part)
 *   upload_bytes  – bytes uploaded
 * Scopes: global, project, zone, api_key.
 */

export const METRICS = ['storage_bytes', 'egress_bytes', 'requests', 'transforms', 'upload_bytes'] as const;
export type Metric = (typeof METRICS)[number];
export const SCOPE_TYPES = ['global', 'project', 'zone', 'api_key'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface Scope {
  type: ScopeType;
  id: string;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? 0 : Number(v));
const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;

export function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function likePrefix(path: string): string {
  return `${path.replace(/[\\%_]/g, '\\$&')}/%`;
}

/** SQL predicate on a "Folder" alias restricting to the given root paths. */
function folderRootsSql(alias: string, roots: string[]): Prisma.Sql {
  if (roots.length === 0) return Prisma.sql`FALSE`;
  const col = Prisma.raw(`${alias}."path"`);
  return Prisma.join(
    roots.map((r) => Prisma.sql`(${col} = ${r} OR ${col} LIKE ${likePrefix(r)})`),
    ' OR ',
  );
}

async function scopeRoots(scope: Scope): Promise<string[] | null> {
  if (scope.type === 'global' || scope.type === 'api_key') return null;
  const reg = await getZones();
  const zones = scope.type === 'zone' ? reg.zones.filter((z) => z.id === scope.id) : reg.zones.filter((z) => z.projectId === scope.id);
  return zones.filter((z) => z.rootFolder).map((z) => z.rootFolder!.path);
}

function requestScopeSql(scope: Scope): Prisma.Sql {
  switch (scope.type) {
    case 'global':
      return Prisma.sql`TRUE`;
    case 'project':
      return Prisma.sql`"projectId" = ${scope.id}`;
    case 'zone':
      return Prisma.sql`"zoneId" = ${scope.id}`;
    case 'api_key':
      return Prisma.sql`"apiKeyId" = ${scope.id}`;
  }
}

export async function storageBytes(scope: Scope): Promise<number> {
  const prisma = getPrisma();
  if (scope.type === 'global') {
    const [f, v] = await Promise.all([prisma.file.aggregate({ _sum: { size: true } }), prisma.fileVersion.aggregate({ _sum: { size: true } })]);
    return num(f._sum.size) + num(v._sum.size);
  }
  if (scope.type === 'api_key') {
    const f = await prisma.file.aggregate({ _sum: { size: true }, where: { uploadedByApiKeyId: scope.id } });
    return num(f._sum.size);
  }
  const roots = (await scopeRoots(scope)) ?? [];
  if (roots.length === 0) return 0;
  const [r] = await prisma.$queryRaw<Row[]>`
    SELECT coalesce(sum(f."size"), 0) + coalesce((SELECT sum(v."size") FROM "FileVersion" v JOIN "File" f2 ON f2."id" = v."fileId" JOIN "Folder" fo2 ON fo2."id" = f2."folderId" WHERE ${folderRootsSql('fo2', roots)}), 0) AS bytes
    FROM "File" f JOIN "Folder" fo ON fo."id" = f."folderId" WHERE ${folderRootsSql('fo', roots)}`;
  return num(r?.bytes);
}

export async function uploadBytes(scope: Scope, since: Date): Promise<number> {
  const prisma = getPrisma();
  if (scope.type === 'global') return num((await prisma.file.aggregate({ _sum: { size: true }, where: { createdAt: { gte: since } } }))._sum.size);
  if (scope.type === 'api_key') return num((await prisma.file.aggregate({ _sum: { size: true }, where: { createdAt: { gte: since }, uploadedByApiKeyId: scope.id } }))._sum.size);
  const roots = (await scopeRoots(scope)) ?? [];
  if (roots.length === 0) return 0;
  const [r] = await prisma.$queryRaw<Row[]>`
    SELECT coalesce(sum(f."size"), 0) AS bytes FROM "File" f JOIN "Folder" fo ON fo."id" = f."folderId"
    WHERE f."createdAt" >= ${utc(since)} AND (${folderRootsSql('fo', roots)})`;
  return num(r?.bytes);
}

export async function trafficUsage(scope: Scope, since: Date, until = new Date()): Promise<{ egress_bytes: number; requests: number; transforms: number; cpu_ms: number }> {
  const [r] = await getPrisma().$queryRaw<Row[]>`
    SELECT coalesce(sum("bytesSent"), 0) AS bytes,
           count(*) FILTER (WHERE "kind" <> 'api') AS requests,
           count(*) FILTER (WHERE "kind" = 'transform' AND "cacheStatus" = 'variant-miss') AS transforms,
           coalesce(sum("cpuMs"), 0) AS cpu
    FROM "FileRequest"
    WHERE "timestamp" >= ${utc(since)} AND "timestamp" < ${utc(until)} AND "kind" <> 'api' AND ${requestScopeSql(scope)}`;
  return { egress_bytes: num(r?.bytes), requests: num(r?.requests), transforms: num(r?.transforms), cpu_ms: num(r?.cpu) };
}

export async function usageFor(scope: Scope, since = monthStart()): Promise<Record<Metric, number> & { cpu_ms: number }> {
  const [storage, uploads, traffic] = await Promise.all([storageBytes(scope), uploadBytes(scope, since), trafficUsage(scope, since)]);
  return { storage_bytes: storage, upload_bytes: uploads, egress_bytes: traffic.egress_bytes, requests: traffic.requests, transforms: traffic.transforms, cpu_ms: traffic.cpu_ms };
}

export async function metricValue(scope: Scope, metric: Metric, since: Date): Promise<number> {
  switch (metric) {
    case 'storage_bytes':
      return storageBytes(scope);
    case 'upload_bytes':
      return uploadBytes(scope, since);
    default:
      return (await trafficUsage(scope, since))[metric];
  }
}

// ─── Hard limits ────────────────────────────────────────────────────────────

const overCache = new Map<string, { at: number; over: boolean }>();
const OVER_TTL_MS = 60_000;

let quotaRows: { at: number; rows: Quota[] } | null = null;
async function allQuotas(): Promise<Quota[]> {
  if (quotaRows && Date.now() - quotaRows.at < 30_000) return quotaRows.rows;
  const rows = await getPrisma().quota.findMany();
  quotaRows = { at: Date.now(), rows };
  return rows;
}

export function invalidateQuotas(): void {
  quotaRows = null;
  overCache.clear();
}

function scopesFor(zone: ZoneWithRelations | null, apiKeyId: string | null): Scope[] {
  const scopes: Scope[] = [{ type: 'global', id: '' }];
  if (zone) scopes.push({ type: 'project', id: zone.projectId }, { type: 'zone', id: zone.id });
  if (apiKeyId) scopes.push({ type: 'api_key', id: apiKeyId });
  return scopes;
}

async function overHardLimit(q: Quota, extra = 0): Promise<boolean> {
  const key = q.id;
  const hit = overCache.get(key);
  if (extra === 0 && hit && Date.now() - hit.at < OVER_TTL_MS) return hit.over;
  const used = await metricValue({ type: q.scopeType as ScopeType, id: q.scopeId }, q.metric as Metric, q.periodStart > monthStart() ? q.periodStart : monthStart());
  const over = used + extra > Number(q.limit);
  if (extra === 0) overCache.set(key, { at: Date.now(), over });
  return over;
}

/** Throws quota_exceeded when a hard delivery quota (egress / requests / transforms) is exhausted. */
export async function assertDeliveryQuota(zone: ZoneWithRelations | null, apiKeyId: string | null, metric: 'egress_bytes' | 'requests' | 'transforms'): Promise<void> {
  const scopes = scopesFor(zone, apiKeyId);
  // Every delivery counts against egress and request quotas; transformations also against transforms.
  const relevant: string[] = metric === 'transforms' ? ['transforms', 'egress_bytes', 'requests'] : ['egress_bytes', 'requests'];
  const quotas = (await allQuotas()).filter((q) => q.hard && relevant.includes(q.metric) && scopes.some((s) => s.type === q.scopeType && s.id === q.scopeId));
  for (const q of quotas) {
    if (await overHardLimit(q)) {
      void securityEvent('QUOTA_EXCEEDED', { severity: 'info', apiKeyId, details: { quota_id: q.id, metric: q.metric, scope: `${q.scopeType}:${q.scopeId}` } });
      throw new AppError('quota_exceeded', `The ${q.metric.replace('_', ' ')} quota for this ${q.scopeType === 'global' ? 'platform' : q.scopeType.replace('_', ' ')} has been reached.`);
    }
  }
}

/** Throws quota_exceeded when storing `bytes` more would exceed a hard storage / upload quota. */
export async function assertUploadQuota(zone: ZoneWithRelations | null, apiKeyId: string | null, bytes: number): Promise<void> {
  const scopes = scopesFor(zone, apiKeyId);
  const quotas = (await allQuotas()).filter((q) => q.hard && (q.metric === 'storage_bytes' || q.metric === 'upload_bytes') && scopes.some((s) => s.type === q.scopeType && s.id === q.scopeId));
  for (const q of quotas) {
    if (await overHardLimit(q, bytes)) throw new AppError('quota_exceeded', `The upload would exceed the ${q.metric.replace('_', ' ')} quota.`);
  }
}

// ─── Alerts ─────────────────────────────────────────────────────────────────

/** Evaluates every quota, resets monthly periods and emits threshold alerts. Run by the worker. */
export async function evaluateQuotaAlerts(): Promise<number> {
  const prisma = getPrisma();
  const settings = await getSettings();
  const quotas = await prisma.quota.findMany();
  const currentMonth = monthStart();
  let alerts = 0;
  for (const q of quotas) {
    let alerted = q.alertedPercent;
    if (q.periodStart < currentMonth) {
      await prisma.quota.update({ where: { id: q.id }, data: { periodStart: currentMonth, alertedPercent: 0 } });
      alerted = 0;
    }
    const used = await metricValue({ type: q.scopeType as ScopeType, id: q.scopeId }, q.metric as Metric, currentMonth);
    const percent = Number(q.limit) > 0 ? Math.floor((used / Number(q.limit)) * 100) : 0;
    const crossed = [...q.thresholds].sort((a, b) => a - b).filter((t) => percent >= t && t > alerted).pop();
    if (crossed === undefined) continue;
    alerts++;
    await prisma.quota.update({ where: { id: q.id }, data: { alertedPercent: crossed } });
    const payload = { quota_id: q.id, scope_type: q.scopeType, scope_id: q.scopeId, metric: q.metric, limit: Number(q.limit), used, percent, threshold: crossed, hard: q.hard };
    await audit({ actorType: 'system', actorLabel: 'quota-monitor' }, 'QUOTA_UPDATE', { type: 'quota', id: q.id }, { alert: payload });
    if (settings.usage.alertWebhooks) {
      const projectId = q.scopeType === 'project' ? q.scopeId : q.scopeType === 'zone' ? (await getZones()).byId.get(q.scopeId)?.projectId : undefined;
      await emitWebhookEvent('quota.threshold', payload, { projectId });
    }
    baseLogger.warn(payload, 'quota threshold crossed');
  }
  invalidateQuotas();
  return alerts;
}

// ─── Cost estimates ─────────────────────────────────────────────────────────

const GB = 1024 ** 3;

/** Estimated monthly cost per storage provider for a scope, from provider cost settings. */
export async function costEstimate(scope: Scope, since = monthStart()) {
  const prisma = getPrisma();
  const providers = await prisma.storageProvider.findMany();
  const roots = await scopeRoots(scope);
  const fileScope =
    scope.type === 'global'
      ? Prisma.sql`TRUE`
      : scope.type === 'api_key'
        ? Prisma.sql`f."uploadedByApiKeyId" = ${scope.id}`
        : roots && roots.length
          ? Prisma.sql`f."folderId" IN (SELECT fo."id" FROM "Folder" fo WHERE ${folderRootsSql('fo', roots)})`
          : Prisma.sql`FALSE`;
  const reqScope =
    scope.type === 'global' ? Prisma.sql`TRUE` : scope.type === 'project' ? Prisma.sql`r."projectId" = ${scope.id}` : scope.type === 'zone' ? Prisma.sql`r."zoneId" = ${scope.id}` : Prisma.sql`r."apiKeyId" = ${scope.id}`;
  const [stored, egress] = await Promise.all([
    prisma.$queryRaw<Row[]>`SELECT f."storageProviderId" AS id, coalesce(sum(f."size"), 0) AS bytes FROM "File" f WHERE ${fileScope} GROUP BY 1`,
    prisma.$queryRaw<Row[]>`SELECT f."storageProviderId" AS id, coalesce(sum(r."bytesSent"), 0) AS bytes, count(*) AS requests
      FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId"
      WHERE r."timestamp" >= ${utc(since)} AND r."kind" <> 'api' AND ${reqScope} GROUP BY 1`,
  ]);
  const storedMap = new Map(stored.map((r) => [String(r.id), num(r.bytes)]));
  const egressMap = new Map(egress.map((r) => [String(r.id), { bytes: num(r.bytes), requests: num(r.requests) }]));
  const lines = providers
    .map((p) => {
      const storage = storedMap.get(p.id) ?? 0;
      const out = egressMap.get(p.id) ?? { bytes: 0, requests: 0 };
      const storageCost = (storage / GB) * p.costStoragePerGbMonth;
      const egressCost = (out.bytes / GB) * p.costEgressPerGb;
      const requestCost = (out.requests / 1_000_000) * p.costPerMillionRequests;
      return {
        provider: { id: p.id, name: p.name, kind: p.kind, region: p.region },
        storage_bytes: storage,
        egress_bytes: out.bytes,
        requests: out.requests,
        storage_cost: round(storageCost),
        egress_cost: round(egressCost),
        request_cost: round(requestCost),
        total: round(storageCost + egressCost + requestCost),
      };
    })
    .filter((l) => l.storage_bytes > 0 || l.egress_bytes > 0);
  return { currency: (await getSettings()).usage.currency, lines, total: round(lines.reduce((a, l) => a + l.total, 0)) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
