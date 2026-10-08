import { z } from 'zod';
import { getPrisma, Prisma } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { cloudflareCacheStats, cloudflareConfigFor } from '../lib/cloudflare.js';
import { enqueueEdge } from '../lib/queue.js';
import { getSettings } from '../lib/settings.js';
import { folderPathOf, getZones, zoneForPath } from '../lib/zones.js';
import { requireFile } from '../services/files.js';
import { cachePolicy, zoneRelativePath } from '../services/cachePolicy.js';
import { createPurge, fileEdgeUrls, PURGE_TYPES } from '../services/purge.js';
import { resolveRange } from '../services/analytics.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? 0 : Number(v));

function serializePurge(p: { id: string; zoneId: string | null; type: string; targets: string[]; status: string; edgeResult: unknown; createdByLabel: string | null; createdAt: Date; completedAt: Date | null }) {
  return {
    id: p.id,
    object: 'cache_purge' as const,
    zone_id: p.zoneId,
    type: p.type,
    targets: p.targets,
    status: p.status,
    edge_result: p.edgeResult,
    created_by: p.createdByLabel,
    created_at: p.createdAt.toISOString(),
    completed_at: p.completedAt?.toISOString() ?? null,
  };
}

export const cacheRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/cache/purge',
    tag: 'Cache',
    summary: 'Purge the CDN cache',
    description:
      'Purges edge caches by `url`, `file` (file ids — all URLs, signed URLs and image variants), `folder` (folder ids — everything beneath), `tag` (cache tags), `zone` (zone ids) or `everything`. Purges run asynchronously through the Cloudflare API when credentials are configured; otherwise they are recorded as `origin_only`.',
    auth: 'any',
    permission: 'cache.purge',
    scope: 'cache:purge',
    body: z.object({ type: z.enum(PURGE_TYPES), targets: z.array(z.string().min(1).max(2000)).max(1000).default([]), zone_id: z.string().optional() }),
    responses: { 202: { description: 'Purge queued', example: { id: 'pur_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', status: 'pending' } } },
    rateLimit: { name: 'cache-purge', max: 60, windowSeconds: 60 },
    errors: ['validation_failed', 'zone_not_found', 'file_not_found', 'folder_not_found'],
    async handler({ req, reply, body }) {
      const reg = await getZones();
      const keyProject = req.auth?.type === 'api_key' ? req.auth.apiKey.projectId : null;
      let zoneId: string | null = null;
      if (body.zone_id) {
        const zone = reg.byId.get(body.zone_id);
        if (!zone || (keyProject && zone.projectId !== keyProject)) throw new AppError('zone_not_found');
        zoneId = zone.id;
      }
      if (body.type !== 'everything' && body.targets.length === 0) throw new AppError('validation_failed', 'targets must not be empty.');
      if (body.type === 'everything' && keyProject && !zoneId) throw new AppError('validation_failed', 'Project-bound API keys must pass zone_id to purge everything.');
      // Validate targets the caller is allowed to see.
      if (body.type === 'file') for (const id of body.targets) await requireFile(req, id, { includeDeleted: true });
      if (body.type === 'folder') {
        const { requireFolder } = await import('../lib/folders.js');
        for (const id of body.targets) await requireFolder(req, id);
      }
      if (body.type === 'zone') {
        for (const id of body.targets) {
          const z2 = reg.byId.get(id);
          if (!z2 || (keyProject && z2.projectId !== keyProject)) throw new AppError('zone_not_found');
        }
      }
      if (body.type === 'url') {
        for (const u of body.targets) {
          try {
            const url = new URL(u);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
          } catch {
            throw new AppError('validation_failed', `Invalid URL: ${u}`);
          }
        }
      }
      const purge = await createPurge({ zoneId, type: body.type, targets: body.targets, actor: actorOf(req) });
      reply.code(202);
      return serializePurge(purge);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/cache/purges',
    tag: 'Cache',
    summary: 'Purge history',
    auth: 'any',
    permission: 'zones.view',
    scope: 'cache:purge',
    query: pageQuery.extend({ zone_id: z.string().optional() }),
    async handler({ query }) {
      const where: Prisma.CachePurgeWhereInput = query.zone_id ? { zoneId: query.zone_id } : {};
      const prisma = getPrisma();
      const [total, rows] = await Promise.all([
        prisma.cachePurge.count({ where }),
        prisma.cachePurge.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(rows.map(serializePurge), total, query.page, query.limit);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/cache/stats',
    tag: 'Cache',
    summary: 'Cache statistics',
    description:
      'Origin-side cache statistics (revalidations, ranges, redirects, image-variant hits/misses) from request logs, plus the edge HIT / MISS / EXPIRED / BYPASS breakdown from Cloudflare analytics when credentials are configured.',
    auth: 'any',
    permission: 'analytics.view',
    scope: 'analytics:read',
    query: z.object({ zone_id: z.string().optional(), period: z.enum(['24h', '7d', '30d']).default('24h') }),
    async handler({ query }) {
      const range = resolveRange(query.period);
      const zoneFilter = query.zone_id ? Prisma.sql`AND "zoneId" = ${query.zone_id}` : Prisma.empty;
      const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
      const [origin, series, topMisses] = await Promise.all([
        getPrisma().$queryRaw<Row[]>`
          SELECT coalesce("cacheStatus", 'unknown') AS status, count(*) AS requests, coalesce(sum("bytesSent"), 0) AS bytes
          FROM "FileRequest" WHERE "kind" <> 'api' AND "timestamp" >= ${utc(range.from)} ${zoneFilter} GROUP BY 1 ORDER BY 2 DESC`,
        getPrisma().$queryRaw<Row[]>`
          SELECT date_trunc(${range.unit}, "timestamp") AS bucket,
                 count(*) FILTER (WHERE "cacheStatus" IN ('revalidated', 'variant-hit')) AS hits,
                 count(*) FILTER (WHERE "cacheStatus" NOT IN ('revalidated', 'variant-hit') OR "cacheStatus" IS NULL) AS misses
          FROM "FileRequest" WHERE "kind" <> 'api' AND "timestamp" >= ${utc(range.from)} ${zoneFilter} GROUP BY 1 ORDER BY 1`,
        getPrisma().$queryRaw<Row[]>`
          SELECT r."fileId" AS id, f."name" AS name, count(*) AS requests, coalesce(sum(r."bytesSent"), 0) AS bytes
          FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId"
          WHERE r."kind" <> 'api' AND r."timestamp" >= ${utc(range.from)} AND r."statusCode" = 200 ${query.zone_id ? Prisma.sql`AND r."zoneId" = ${query.zone_id}` : Prisma.empty}
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      ]);
      const reg = await getZones();
      const zone = query.zone_id ? (reg.byId.get(query.zone_id) ?? null) : null;
      let edge: unknown = null;
      let edgeError: string | null = null;
      const cfg = cloudflareConfigFor(zone);
      if (cfg) {
        try {
          const hosts = zone ? zone.domains.filter((d) => d.status === 'ACTIVE').map((d) => d.hostname) : undefined;
          // Cloudflare adaptive analytics allow at most a 24h window on most plans.
          const since = new Date(Math.max(range.from.getTime(), Date.now() - 86_400_000));
          edge = await cloudflareCacheStats(cfg, since, new Date(), hosts);
        } catch (err) {
          edgeError = (err as Error).message;
        }
      }
      const totalOrigin = origin.reduce((a, r) => a + num(r.requests), 0);
      const originHits = origin.filter((r) => r.status === 'revalidated' || r.status === 'variant-hit').reduce((a, r) => a + num(r.requests), 0);
      return {
        period: query.period,
        origin: {
          statuses: origin.map((r) => ({ status: String(r.status), requests: num(r.requests), bytes: num(r.bytes) })),
          hit_ratio: totalOrigin ? Math.round((originHits / totalOrigin) * 1000) / 1000 : 0,
          series: series.map((r) => ({ t: (r.bucket as Date).toISOString(), hits: num(r.hits), misses: num(r.misses) })),
          top_origin_files: topMisses.map((r) => ({ id: String(r.id), name: String(r.name), requests: num(r.requests), bytes: num(r.bytes) })),
        },
        edge,
        edge_error: edgeError,
        edge_configured: Boolean(cfg),
      };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/cache/prewarm',
    tag: 'Cache',
    summary: 'Pre-warm the edge cache',
    description: 'Fetches public URLs through the edge so they are cached before visitors request them. Pass explicit `urls`, `file_ids`, or `top` to warm the most-requested public files of the last 7 days.',
    auth: 'any',
    permission: 'cache.purge',
    scope: 'cache:purge',
    body: z.object({
      urls: z.array(z.string().url()).max(500).optional(),
      file_ids: z.array(z.string()).max(500).optional(),
      top: z.number().int().min(1).max(500).optional(),
      zone_id: z.string().optional(),
    }),
    responses: { 202: { description: 'Queued', example: { urls: 42 } } },
    errors: ['validation_failed'],
    async handler({ req, reply, body }) {
      const urls = new Set(body.urls ?? []);
      const reg = await getZones();
      const prisma = getPrisma();
      let ids = [...(body.file_ids ?? [])];
      if (body.top) {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT r."fileId" AS id FROM "FileRequest" r JOIN "File" f ON f."id" = r."fileId"
          WHERE r."timestamp" > now() - interval '7 days' AND f."visibility" = 'PUBLIC' AND f."deletedAt" IS NULL
          ${body.zone_id ? Prisma.sql`AND r."zoneId" = ${body.zone_id}` : Prisma.empty}
          GROUP BY 1 ORDER BY count(*) DESC LIMIT ${body.top}`;
        ids = ids.concat(rows.map((r) => r.id));
      }
      for (const id of ids) {
        if (!isValidId('file', id)) continue;
        const f = await requireFile(req, id).catch(() => null);
        if (!f || f.visibility !== 'PUBLIC') continue;
        const folderPath = await folderPathOf(f.folderId);
        for (const u of fileEdgeUrls(f, folderPath, zoneForPath(reg, folderPath))) urls.add(u);
      }
      if (urls.size === 0) throw new AppError('validation_failed', 'Nothing to pre-warm (only public files can be pre-warmed).');
      await enqueueEdge({ type: 'prewarm', urls: [...urls].slice(0, 500) });
      const { audit } = await import('../lib/audit.js');
      await audit(actorOf(req), 'CACHE_PREWARM', null, { urls: urls.size });
      reply.code(202);
      return { urls: urls.size };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/cache',
    tag: 'Cache',
    summary: 'Explain a file’s cache policy',
    description: 'Shows the zone, matching cache rule, edge/browser TTLs, cache tags and the URLs that a purge of this file covers.',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: z.object({ id: z.string().max(64) }),
    errors: ['file_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      const settings = await getSettings();
      const folderPath = await folderPathOf(file.folderId);
      const zone = zoneForPath(await getZones(), folderPath);
      const relPath = zoneRelativePath(folderPath, file.slug, zone);
      const policy = cachePolicy({ file, zone, relPath, settings, isPublic: file.visibility === 'PUBLIC' });
      return {
        zone: zone ? { id: zone.id, name: zone.name, slug: zone.slug } : null,
        path: relPath,
        policy,
        urls: fileEdgeUrls(file, folderPath, zone),
      };
    },
  }),
];
