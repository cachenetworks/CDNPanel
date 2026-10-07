import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { defineRoute, type RouteDef } from '../http/route.js';
import { breakdowns, bandwidthSince, recentErrors, resolveRange, timeSeries, totals } from '../services/analytics.js';
import { requireFile } from '../services/files.js';
import { storageUsed } from '../services/ingest.js';
import { driverFor, ensureDefaultProvider } from '../lib/storageRegistry.js';
import { getSettings } from '../lib/settings.js';
import { serializeFile, FILE_INCLUDE } from '../lib/serialize.js';

const rangeQuery = z.object({
  period: z.enum(['24h', '7d', '30d', '90d', 'custom']).default('7d'),
  from: z.coerce.date().optional().describe('Start (ISO 8601) for period=custom'),
  to: z.coerce.date().optional().describe('End (ISO 8601) for period=custom'),
  api_key_id: z.string().max(64).optional().describe('Restrict to requests made with this API key'),
});

const TOTALS_EXAMPLE = { requests: 15230, downloads: 9120, bandwidth: 73400320000, errors: 41, api_errors: 12, cache_hits: 2210, cache_hit_ratio: 0.18, avg_response_ms: 12.4, p95_response_ms: 48.2 };
const SERIES_EXAMPLE = [{ t: '2026-01-01T00:00:00.000Z', requests: 812, downloads: 400, bandwidth: 3221225472, errors: 2, cache_hits: 120, avg_ms: 11.2, uploads: 14 }];

function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfUtcMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export const analyticsRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/analytics',
    tag: 'Analytics',
    summary: 'Analytics overview',
    description:
      'Totals, a time series (hourly for ≤ 3 days, otherwise daily) and breakdowns by status code, country, MIME type, file, folder and API key, plus recent errors. Use `period` or `period=custom` with `from`/`to`.',
    auth: 'any',
    permission: 'analytics.view',
    scope: 'analytics:read',
    query: rangeQuery,
    responses: {
      200: {
        description: 'Analytics',
        example: {
          range: { from: '2025-12-25T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', unit: 'day' },
          totals: TOTALS_EXAMPLE,
          series: SERIES_EXAMPLE,
          breakdowns: { status_codes: [{ code: 200, count: 9000 }], countries: [], mime_types: [], top_files: [], top_api_keys: [], top_folders: [] },
          recent_errors: [],
        },
      },
    },
    errors: ['validation_failed'],
    async handler({ query }) {
      const range = resolveRange(query.period, query.from, query.to);
      const filter = { apiKeyId: query.api_key_id };
      const [t, series, b, errors] = await Promise.all([totals(range, filter), timeSeries(range, filter), breakdowns(range, filter), recentErrors(range)]);
      return { range: { from: range.from.toISOString(), to: range.to.toISOString(), unit: range.unit }, totals: t, series, breakdowns: b, recent_errors: errors };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/analytics/files/:id',
    tag: 'Analytics',
    summary: 'Analytics for a file',
    auth: 'any',
    permission: 'analytics.view',
    scope: 'analytics:read',
    params: z.object({ id: z.string().max(64) }),
    query: rangeQuery.omit({ api_key_id: true }),
    responses: { 200: { description: 'File analytics', example: { file_id: 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', totals: TOTALS_EXAMPLE, series: SERIES_EXAMPLE, lifetime: { downloads: 120, bandwidth: 52428800 } } } },
    errors: ['file_not_found'],
    async handler({ req, params, query }) {
      const file = await requireFile(req, params.id);
      const range = resolveRange(query.period, query.from, query.to);
      const filter = { fileId: file.id };
      const [t, series, b] = await Promise.all([totals(range, filter), timeSeries(range, filter), breakdowns(range, filter)]);
      return {
        file_id: file.id,
        range: { from: range.from.toISOString(), to: range.to.toISOString(), unit: range.unit },
        totals: t,
        series,
        breakdowns: { status_codes: b.status_codes, countries: b.countries, top_api_keys: b.top_api_keys },
        lifetime: { downloads: Number(file.downloadCount), bandwidth: Number(file.bandwidthBytes), last_accessed_at: file.lastAccessedAt?.toISOString() ?? null },
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/analytics/bandwidth',
    tag: 'Analytics',
    summary: 'Bandwidth usage',
    description: 'Bandwidth served today, this month (UTC) and as a time series for the selected period.',
    auth: 'any',
    permission: 'analytics.view',
    scope: 'analytics:read',
    query: rangeQuery.omit({ api_key_id: true }),
    responses: { 200: { description: 'Bandwidth', example: { today: 1073741824, this_month: 53687091200, series: [{ t: '2026-01-01T00:00:00.000Z', bandwidth: 1073741824 }] } } },
    async handler({ query }) {
      const range = resolveRange(query.period, query.from, query.to);
      const [today, month, series] = await Promise.all([bandwidthSince(startOfUtcDay()), bandwidthSince(startOfUtcMonth()), timeSeries(range)]);
      return { today, this_month: month, series: series.map((s) => ({ t: s.t, bandwidth: s.bandwidth })) };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/dashboard/overview',
    tag: 'Dashboard',
    summary: 'Dashboard overview',
    description: 'Aggregated statistics for the staff dashboard home page.',
    auth: 'session',
    permission: 'analytics.view',
    query: rangeQuery.omit({ api_key_id: true }),
    responses: { 200: { description: 'Overview' } },
    async handler({ req, query }) {
      const prisma = getPrisma();
      const range = resolveRange(query.period, query.from, query.to);
      const today = startOfUtcDay();
      const todayRange = { from: today, to: new Date(), unit: 'hour' as const };
      const settings = await getSettings();
      const provider = await ensureDefaultProvider();
      const canSeeFiles = req.auth?.type === 'session' && req.auth.permissions.has('files.view');
      const canSeeLogs = req.auth?.type === 'session' && req.auth.permissions.has('logs.view');
      const [fileCount, used, capacity, uploadsToday, todayTotals, monthBw, todayBw, activeKeys, series, b, recentUploads, activity] = await Promise.all([
        prisma.file.count(),
        storageUsed(),
        driverFor(provider).capacity().catch(() => ({ available: null, total: null })),
        prisma.file.count({ where: { createdAt: { gte: today } } }),
        totals(todayRange),
        bandwidthSince(startOfUtcMonth()),
        bandwidthSince(today),
        prisma.apiKey.count({ where: { revokedAt: null, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
        timeSeries(range),
        breakdowns(range),
        canSeeFiles ? prisma.file.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: FILE_INCLUDE }) : Promise.resolve([]),
        canSeeLogs ? prisma.auditLog.findMany({ orderBy: { timestamp: 'desc' }, take: 10 }) : Promise.resolve([]),
      ]);
      const capacityBytes = settings.uploads.quotaBytes ?? (provider.capacity ? Number(provider.capacity) : capacity.total);
      return {
        range: { from: range.from.toISOString(), to: range.to.toISOString(), unit: range.unit },
        stats: {
          total_files: fileCount,
          storage_used: used,
          storage_capacity: capacityBytes,
          storage_available: capacity.available,
          uploads_today: uploadsToday,
          downloads_today: todayTotals.downloads,
          requests_today: todayTotals.requests,
          bandwidth_today: todayBw,
          bandwidth_month: monthBw,
          active_api_keys: activeKeys,
          failed_api_requests_today: todayTotals.api_errors,
        },
        series,
        status_codes: b.status_codes,
        top_files: b.top_files,
        recent_uploads: recentUploads.map(serializeFile),
        recent_activity: activity.map((a) => ({
          id: a.id,
          timestamp: a.timestamp.toISOString(),
          actor: a.actorLabel,
          action: a.action,
          target_type: a.targetType,
          target_id: a.targetId,
        })),
      };
    },
  }),
];
