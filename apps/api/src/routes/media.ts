import path from 'node:path';
import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { enqueueMedia } from '../lib/queue.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { folderPathOf, getZones, zoneBaseUrl, zoneForPath } from '../lib/zones.js';
import { cachePolicy } from '../services/cachePolicy.js';
import { etagMatches, parseRange, prepareDelivery } from '../services/delivery.js';
import { requireFile } from '../services/files.js';
import { CONTENT_TYPES, mediaToken, RENDITION_KINDS, serializeRendition, verifyMediaToken } from '../services/media.js';

export const mediaRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/media/:id/:token/:kind/*',
    tag: 'Media',
    summary: 'Serve a media rendition (CDN)',
    description:
      'Serves rendition objects: thumbnails, previews, MP4 / WebM, HLS playlists and segments, DASH manifests and segments, audio and waveforms. `token` is `pub` for public files or a time-limited media token (from `GET /api/v1/files/{id}/media`) that covers every object of the file, so HLS / DASH players can follow relative URLs. Supports `Range`.',
    auth: 'public',
    params: z.object({ id: z.string().max(64), token: z.string().max(100), kind: z.enum(RENDITION_KINDS) }),
    responses: { 200: { description: 'Rendition object', contentType: 'application/octet-stream' } },
    errors: ['file_not_found', 'invalid_signature', 'access_denied'],
    async handler({ req, reply, params }) {
      if (!isValidId('file', params.id)) throw new AppError('invalid_id');
      const rel = (req.params as { '*': string })['*'] ?? '';
      if (!rel || rel.includes('..') || rel.includes('\\') || rel.length > 200) throw new AppError('not_found');
      const prisma = getPrisma();
      const file = await prisma.file.findUnique({ where: { id: params.id } });
      if (!file || file.status !== 'READY' || file.deletedAt) throw new AppError('file_not_found');
      const ctx = await prepareDelivery(req, reply, file);
      if (!ctx) return reply;
      const isPublic = file.visibility === 'PUBLIC';
      if (!(params.token === 'pub' ? isPublic : verifyMediaToken(file.id, params.token))) throw new AppError('invalid_signature', 'The media token is invalid or has expired.');
      const r = await prisma.mediaRendition.findUnique({ where: { fileId_kind: { fileId: file.id, kind: params.kind } } });
      const files = (r?.metadata as { files?: string[] } | null)?.files ?? [];
      if (!r || r.status !== 'READY' || !files.includes(rel)) throw new AppError('not_found');

      const settings = await getSettings();
      const policy = cachePolicy({ file, zone: ctx.zone, relPath: ctx.relPath, settings, isPublic });
      const ext = path.extname(rel);
      const key = `${r.storageKey}/${rel}`;
      const { driver } = await driverForId(r.storageProviderId);
      const info = await driver.head(key);
      if (!info) throw new AppError('not_found');
      const etag = `"m-${r.id}-${r.updatedAt.getTime()}-${rel.length}"`;
      req.analytics = { fileId: file.id, folderId: file.folderId, mimeType: CONTENT_TYPES[ext] ?? 'application/octet-stream', cacheStatus: 'origin', zoneId: ctx.zone?.id ?? null, projectId: ctx.zone?.projectId ?? null, kind: 'media' };
      reply.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
      reply.header('ETag', etag);
      // Playlists of a VOD rendition never change; private ones are still private.
      reply.header('Cache-Control', isPublic ? policy.cacheControl : 'private, max-age=300');
      if (isPublic && policy.cdnCacheControl) reply.header('CDN-Cache-Control', policy.cdnCacheControl);
      if (isPublic) reply.header('Cache-Tag', policy.tags.join(','));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] && etagMatches(req.headers['if-none-match'], etag)) {
        req.analytics.cacheStatus = 'revalidated';
        return reply.code(304).send();
      }
      const range = parseRange(req.headers.range, info.size);
      if (range === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${info.size}`);
        throw new AppError('range_not_satisfiable');
      }
      const length = range ? range.end - range.start + 1 : info.size;
      if (range) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      reply.header('Content-Length', String(length));
      req.analytics.bytes = req.method === 'HEAD' ? 0 : length;
      if (req.method === 'HEAD') {
        reply.hijack();
        reply.raw.writeHead(range ? 206 : 200, reply.getHeaders() as Record<string, string>);
        reply.raw.end();
        return reply;
      }
      return reply.code(range ? 206 : 200).send(await driver.get(key, range ?? undefined));
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/media',
    tag: 'Media',
    summary: 'List media renditions',
    description: 'Returns renditions with playable URLs. URLs of non-public files carry a media token valid for `ttl` seconds (default 4 hours).',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: z.object({ id: z.string().max(64) }),
    query: z.object({ ttl: z.coerce.number().int().min(60).max(7 * 86_400).default(14_400) }),
    errors: ['file_not_found'],
    async handler({ req, params, query }) {
      const file = await requireFile(req, params.id);
      const rows = await getPrisma().mediaRendition.findMany({ where: { fileId: file.id }, orderBy: { kind: 'asc' } });
      const zone = zoneForPath(await getZones(), await folderPathOf(file.folderId));
      const base = zoneBaseUrl(zone, env().CDN_URL);
      const token = file.visibility === 'PUBLIC' ? 'pub' : mediaToken(file.id, query.ttl);
      return { data: rows.map((r) => serializeRendition(r, base, token)), token_expires_in: file.visibility === 'PUBLIC' ? null : query.ttl };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/media/process',
    tag: 'Media',
    summary: 'Generate media renditions',
    description: 'Queues rendition generation (FFmpeg) for a video or audio file. Defaults to the renditions configured in settings.',
    auth: 'any',
    permission: 'files.edit',
    scope: 'files:update',
    params: z.object({ id: z.string().max(64) }),
    body: z.object({ kinds: z.array(z.enum(RENDITION_KINDS)).max(RENDITION_KINDS.length).optional() }).default({}),
    responses: { 202: { description: 'Queued' } },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed'],
    async handler({ req, reply, params, body }) {
      const file = await requireFile(req, params.id);
      if (file.status !== 'READY') throw new AppError('file_not_ready');
      if (!file.mimeType.startsWith('video/') && !file.mimeType.startsWith('audio/')) throw new AppError('validation_failed', 'Only video and audio files have media renditions.');
      await enqueueMedia(file.id, body.kinds);
      await audit(actorOf(req), 'MEDIA_REPROCESS', { type: 'file', id: file.id }, { kinds: body.kinds ?? 'default' });
      reply.code(202);
      return { queued: true };
    },
  }),
];
