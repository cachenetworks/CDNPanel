import { getPrisma } from '@cdn/database';
import { defineRoute, type RouteDef } from '../http/route.js';
import { getSettings } from '../lib/settings.js';
import { ensureDefaultProvider } from '../lib/storageRegistry.js';
import { storageUsed } from '../services/ingest.js';
import { providerSpace, smallestKnownLimit } from '../services/storageCapacity.js';
import { totals, type Range } from '../services/analytics.js';
import { aiConfigured, analyzeMetrics, type AdvisoryMetrics } from '../services/aiAdvisory.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000);

export const aiRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET', url: '/api/v1/analytics/ai-check', tag: 'Analytics',
    summary: 'Optional AI advisory availability', auth: 'session', permission: 'analytics.view',
    async handler() { return { enabled: aiConfigured(), privacy: 'Only aggregate numeric operational metrics are shared when a staff member manually runs a check.' }; },
  }),
  defineRoute({
    method: 'POST', url: '/api/v1/analytics/ai-check', tag: 'Analytics',
    summary: 'Run a manual AI operational health review',
    description: 'Staff only. Sends aggregate counts and storage metrics to the configured FreeLLMAPI/OpenAI-compatible backend. Advisory output cannot change CDN settings.',
    auth: 'session', permission: 'analytics.view',
    rateLimit: { name: 'ai-advisory', max: 5, windowSeconds: 3600 },
    async handler({ reply }) {
      reply.header('Cache-Control', 'no-store');
      if (!aiConfigured()) return { enabled: false, advisory: null, message: 'Set AI_BASE_URL and AI_MODEL on the API server to enable advisory checks.' };
      const now = new Date();
      const current: Range = { from: hoursAgo(24), to: now, unit: 'hour' };
      const previous: Range = { from: hoursAgo(48), to: current.from, unit: 'hour' };
      const prisma = getPrisma();
      const [a, b, provider, logical] = await Promise.all([totals(current), totals(previous), ensureDefaultProvider(), storageUsed()]);
      const [providerFiles, settings] = await Promise.all([
        prisma.file.aggregate({ where: { storageProviderId: provider.id }, _sum: { size: true } }),
        getSettings(),
      ]);
      const space = await providerSpace(provider, Number(providerFiles._sum.size ?? 0));
      const metrics: AdvisoryMetrics = {
        period_hours: 24, requests: a.requests, downloads: a.downloads, views: a.views,
        share_clicks: a.clicks, errors: a.errors, api_errors: a.api_errors,
        bandwidth_bytes: a.bandwidth, cache_hit_ratio: a.cache_hit_ratio,
        previous_period_requests: b.requests, previous_period_errors: b.errors,
        cdn_logical_bytes: logical,
        known_upload_headroom_bytes: smallestKnownLimit(space.available, settings.uploads.quotaBytes === null ? null : Math.max(0, settings.uploads.quotaBytes - logical)),
        host_disk_free_bytes: space.disk_free, host_disk_total_bytes: space.disk_total,
      };
      try { return { enabled: true, advisory: await analyzeMetrics(metrics), period: 'last 24 hours', privacy: 'Aggregated numeric statistics only.' }; }
      catch (err) { return { enabled: true, advisory: null, message: err instanceof Error ? err.message : 'AI advisory unavailable.' }; }
    },
  }),
];
