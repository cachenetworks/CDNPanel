import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { env } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { folderPathOf, getZones, zoneBaseUrl, zoneForPath } from '../lib/zones.js';
import { authorizeDelivery, etagMatches, prepareDelivery } from '../services/delivery.js';
import { cachePolicy } from '../services/cachePolicy.js';
import { requireFile } from '../services/files.js';
import { canonicalTransform, getOrCreateVariant, parseTransform, purgeVariants, resolveFormat, signTransform, transformQuery, TRANSFORMABLE, verifyTransformSignature } from '../services/images.js';
import { autoPurgeFiles } from '../services/purge.js';

const transformDoc = {
  w: 'Width in CSS pixels', h: 'Height in CSS pixels', dpr: 'Device pixel ratio (1–4)', fit: 'cover | contain | fill | inside | outside',
  pos: 'Crop position: center, top, left, …, attention, entropy', format: 'auto (Accept-based) | webp | avif | jpeg | png', q: 'Quality 1–100',
  rotate: '0 | 90 | 180 | 270', flip: 'Flip vertically', flop: 'Flip horizontally', blur: 'Gaussian blur sigma 0.3–100', sharpen: 'Sharpen sigma 0.5–10',
  crop: 'Extract x,y,w,h before resizing', bg: 'Background hex colour for contain / flatten', grayscale: 'Convert to greyscale',
  wm: 'Watermark file id', wm_pos: 'Watermark gravity (southeast default)', wm_opacity: 'Watermark opacity 0.05–1', wm_scale: 'Watermark width as a fraction of the image width',
  keep_meta: 'Keep EXIF / ICC metadata (stripped by default, GPS included)', s: 'Transformation signature',
};

export const imageRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/img/:id',
    tag: 'Images',
    summary: 'Transform an image (CDN)',
    description:
      `On-the-fly image optimisation, e.g. \`/img/file_…?w=800&h=600&fit=cover&format=webp&q=80\`. Variants are generated once and cached permanently (keyed by content + parameters); responses are edge-cacheable with the zone TTLs. When signed transforms are required (default) the URL must carry \`s\` — obtain it from \`POST /api/v1/images/sign\`. Parameters: ${Object.entries(transformDoc).map(([k, v]) => `\`${k}\` ${v}`).join('; ')}. Visibility rules match \`/files/{id}\` (signed URL params may be combined).`,
    auth: 'public',
    params: z.object({ id: z.string().max(64) }),
    responses: { 200: { description: 'Transformed image', contentType: 'image/webp' }, 304: { description: 'Not modified' } },
    errors: ['file_not_found', 'transform_invalid', 'transform_unsupported', 'invalid_signature', 'access_denied', 'quota_exceeded'],
    async handler({ req, reply, params }) {
      if (!isValidId('file', params.id)) throw new AppError('invalid_id');
      const settings = await getSettings();
      if (!settings.images.enabled) throw new AppError('not_found');
      const file = await getPrisma().file.findUnique({ where: { id: params.id } });
      if (!file || file.status !== 'READY' || file.deletedAt) throw new AppError('file_not_found');
      if (!TRANSFORMABLE.has(file.mimeType)) throw new AppError('transform_unsupported', `Images of type ${file.mimeType} cannot be transformed.`);
      const ctx = await prepareDelivery(req, reply, file, 'transforms');
      if (!ctx) return reply;
      if (ctx.zone && !ctx.zone.imageOptimization) throw new AppError('not_found');
      authorizeDelivery(req, file, ctx.folderPath);
      const query = req.query as Record<string, unknown>;
      const p = parseTransform(query, settings);
      const canonical = canonicalTransform(p);
      const mustSign = ctx.zone ? ctx.zone.requireSignedTransforms : settings.images.requireSignedTransforms;
      if (mustSign && !verifyTransformSignature(file.id, canonical, query.s)) {
        void securityEvent('TRANSFORM_SIGNATURE_INVALID', { ip: req.clientIp, severity: 'info', details: { file_id: file.id, canonical } });
        throw new AppError('invalid_signature', 'This transformation URL is not signed. Create signed URLs with POST /api/v1/images/sign.');
      }
      const format = resolveFormat(p, file.mimeType, req.headers.accept);
      const { variant, created, cpuMs } = await getOrCreateVariant(file, p, canonical, format, settings);
      void getPrisma().imageVariant.update({ where: { id: variant.id }, data: { hits: { increment: 1 }, lastAccessedAt: new Date() } }).catch(() => undefined);

      const isPublic = file.visibility === 'PUBLIC';
      const policy = cachePolicy({ file, zone: ctx.zone, relPath: ctx.relPath, settings, isPublic });
      const etag = `"v-${variant.paramsHash}"`;
      req.analytics = { fileId: file.id, folderId: file.folderId, mimeType: variant.mimeType, cacheStatus: created ? 'variant-miss' : 'variant-hit', zoneId: ctx.zone?.id ?? null, projectId: ctx.zone?.projectId ?? null, kind: 'transform', cpuMs };
      reply.header('Content-Type', variant.mimeType);
      reply.header('ETag', etag);
      reply.header('Cache-Control', policy.cacheControl);
      if (policy.cdnCacheControl) reply.header('CDN-Cache-Control', policy.cdnCacheControl);
      if (isPublic) reply.header('Cache-Tag', policy.tags.join(','));
      reply.header('Vary', p.format === 'auto' ? (isPublic ? 'Accept' : 'Accept, Authorization, Cookie') : isPublic ? 'Accept-Encoding' : 'Authorization, Cookie');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cross-Origin-Resource-Policy', isPublic ? 'cross-origin' : 'same-site');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header('X-CDN-Variant', created ? 'MISS' : 'HIT');
      reply.header('Timing-Allow-Origin', '*');
      if (req.headers['if-none-match'] && etagMatches(req.headers['if-none-match'], etag)) {
        req.analytics.cacheStatus = 'revalidated';
        return reply.code(304).send();
      }
      reply.header('Content-Length', String(variant.size));
      req.analytics.bytes = req.method === 'HEAD' ? 0 : Number(variant.size);
      if (req.method === 'HEAD') {
        reply.hijack();
        reply.raw.writeHead(200, reply.getHeaders() as Record<string, string>);
        reply.raw.end();
        return reply;
      }
      const { driver } = await driverForId(variant.storageProviderId);
      return reply.code(200).send(await driver.get(variant.storageKey));
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/images/sign',
    tag: 'Images',
    summary: 'Sign an image transformation URL',
    description: 'Validates the parameters and returns a signed `/img/` URL (on the zone primary domain when the file belongs to a zone with an active domain).',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    body: z.object({ file_id: z.string(), params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}) }),
    responses: { 200: { description: 'Signed URL', example: { url: 'https://cdn.example.com/img/file_…?format=webp&q=80&w=800&s=1.Xy…', canonical: 'w=800&format=webp&q=80' } } },
    errors: ['file_not_found', 'transform_invalid', 'transform_unsupported'],
    async handler({ req, body }) {
      const file = await requireFile(req, body.file_id);
      if (!TRANSFORMABLE.has(file.mimeType)) throw new AppError('transform_unsupported');
      const settings = await getSettings();
      const raw = Object.fromEntries(Object.entries(body.params).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]));
      for (const [k, v] of Object.entries(raw)) if (v === '0' && ['flip', 'flop', 'grayscale', 'keep_meta'].includes(k)) delete raw[k];
      const p = parseTransform(raw, settings);
      const canonical = canonicalTransform(p);
      const sig = signTransform(file.id, canonical);
      const zone = zoneForPath(await getZones(), await folderPathOf(file.folderId));
      const base = zoneBaseUrl(zone, env().CDN_URL);
      return { url: `${base}/img/${file.id}?${transformQuery(canonical, sig)}`, canonical, signature: sig };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/variants',
    tag: 'Images',
    summary: 'List image variants',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: z.object({ id: z.string().max(64) }),
    errors: ['file_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      const rows = await getPrisma().imageVariant.findMany({ where: { fileId: file.id }, orderBy: { hits: 'desc' }, take: 200 });
      return {
        data: rows.map((v) => ({
          id: v.id,
          params: v.params,
          mime_type: v.mimeType,
          size: Number(v.size),
          width: v.width,
          height: v.height,
          hits: Number(v.hits),
          last_accessed_at: v.lastAccessedAt.toISOString(),
          created_at: v.createdAt.toISOString(),
        })),
      };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/files/:id/variants',
    tag: 'Images',
    summary: 'Delete cached image variants',
    description: 'Removes stored variants (they are regenerated on demand) and purges the file from edge caches.',
    auth: 'any',
    permission: 'files.edit',
    scope: 'files:update',
    params: z.object({ id: z.string().max(64) }),
    errors: ['file_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      const deleted = await purgeVariants(file.id);
      await autoPurgeFiles([file], 'variants deleted');
      const { audit } = await import('../lib/audit.js');
      await audit(actorOf(req), 'FILE_UPDATE', { type: 'file', id: file.id }, { variants_deleted: deleted });
      return { deleted };
    },
  }),
];
