import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getPrisma, Prisma, type ShareLink } from '@cdn/database';
import { AppError, isValidId, newId, randomBase62, sha256Hex } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { isValidIpOrCidr } from '../lib/ip.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { getSettings } from '../lib/settings.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { folderPathOf, getZones, zoneBaseUrl, zoneForPath } from '../lib/zones.js';
import { sendFile, prepareDelivery } from '../services/delivery.js';
import { requireFile } from '../services/files.js';
import {
  assertShareAccess,
  consumeDownload,
  findShareByToken,
  isUnlocked,
  needsUnlock,
  recordShareAccess,
  renderSharePage,
  sendHtml,
  setUnlocked,
  shareState,
} from '../services/shares.js';

const tokenParams = z.object({ token: z.string().max(64) });

async function shareUrl(share: { fileId: string }, token: string): Promise<string> {
  const file = await getPrisma().file.findUnique({ where: { id: share.fileId }, select: { folderId: true } });
  const zone = zoneForPath(await getZones(), await folderPathOf(file?.folderId ?? null));
  return `${zoneBaseUrl(zone, env().CDN_URL)}/s/${token}`;
}

export function serializeShare(s: ShareLink & { file?: { id: string; name: string } }, url?: string) {
  return {
    id: s.id,
    object: 'share_link' as const,
    file_id: s.fileId,
    file: s.file ? { id: s.file.id, name: s.file.name } : undefined,
    url: url ?? null,
    token_prefix: s.tokenPrefix,
    title: s.title,
    message: s.message,
    has_password: Boolean(s.passwordHash),
    expires_at: s.expiresAt?.toISOString() ?? null,
    max_downloads: s.maxDownloads,
    download_count: s.downloadCount,
    one_time: s.oneTime,
    allowed_ips: s.allowedIps,
    allowed_countries: s.allowedCountries,
    require_email: s.requireEmail,
    state: shareState(s),
    revoked_at: s.revokedAt?.toISOString() ?? null,
    last_accessed_at: s.lastAccessedAt?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
  };
}

async function requireShare(req: FastifyRequest, id: string) {
  if (!isValidId('shareLink', id)) throw new AppError('invalid_id');
  const share = await getPrisma().shareLink.findUnique({ where: { id }, include: { file: { select: { id: true, name: true } } } });
  if (!share) throw new AppError('share_not_found');
  await requireFile(req, share.fileId, { includeDeleted: true });
  return share;
}

const shareOptions = {
  title: z.string().trim().max(120).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  expires_at: z.coerce.date().nullable().optional(),
  max_downloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
  allowed_ips: z.array(z.string().refine(isValidIpOrCidr, 'invalid IP or CIDR')).max(100).optional(),
  allowed_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
  require_email: z.boolean().optional(),
};

export const shareRoutes: RouteDef<any, any, any>[] = [
  // ─── Public ───
  defineRoute({
    method: 'GET',
    url: '/s/:token',
    tag: 'Shares',
    summary: 'Share landing page',
    description: 'Human-facing page for a share link: shows the file, asks for the password / email when required and offers the download.',
    auth: 'public',
    params: tokenParams,
    responses: { 200: { description: 'HTML page', contentType: 'text/html' } },
    async handler({ req, reply, params }) {
      const settings = await getSettings();
      let share;
      try {
        share = await findShareByToken(params.token);
        assertShareAccess(req, share);
      } catch (err) {
        const status = err instanceof AppError ? err.status : 404;
        const message = err instanceof AppError ? err.message : 'This share link is not available.';
        return sendHtml(reply, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><body style="font:15px system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:28rem;padding:16px;text-align:center"><h1>Link unavailable</h1><p>${message.replace(/[<>&]/g, '')}</p></main></body>`, status);
      }
      await recordShareAccess(req, share, { downloaded: false });
      return sendHtml(reply, renderSharePage({ siteName: settings.general.siteName, share, token: params.token, unlocked: isUnlocked(req, share) }));
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/s/:token/unlock',
    tag: 'Shares',
    summary: 'Unlock a protected share link',
    auth: 'public',
    hidden: true,
    skipCsrf: true,
    params: tokenParams,
    rateLimit: { name: 'share-unlock', max: 10, windowSeconds: 300 },
    async handler({ req, reply, params }) {
      const settings = await getSettings();
      const share = await findShareByToken(params.token);
      assertShareAccess(req, share);
      const form = (req.body ?? {}) as Record<string, string>;
      const render = (error: string, status: number) => sendHtml(reply, renderSharePage({ siteName: settings.general.siteName, share, token: params.token, unlocked: false, error }), status);
      let email: string | null = null;
      if (share.requireEmail) {
        email = String(form.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(email)) return render('Enter a valid email address.', 422);
      }
      if (share.passwordHash && !(await verifyPassword(share.passwordHash, String(form.password ?? '')))) {
        await recordShareAccess(req, share, { email, downloaded: false });
        return render('Incorrect password.', 401);
      }
      setUnlocked(reply, share);
      await recordShareAccess(req, share, { email, downloaded: false });
      return reply.redirect(`/s/${params.token}`, 303);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/s/:token/download',
    tag: 'Shares',
    summary: 'Download through a share link',
    description: 'Streams the shared file (as an attachment). Counts towards the download limit; one-time links are revoked after the first download.',
    auth: 'public',
    params: tokenParams,
    responses: { 200: { description: 'File content', contentType: 'application/octet-stream' } },
    errors: ['share_not_found', 'share_expired', 'share_password_required', 'access_denied'],
    async handler({ req, reply, params }) {
      const share = await findShareByToken(params.token);
      assertShareAccess(req, share);
      if (needsUnlock(share) && !isUnlocked(req, share)) {
        if (req.headers.accept?.includes('text/html')) return reply.redirect(`/s/${params.token}`, 303);
        throw new AppError('share_password_required');
      }
      const ctx = await prepareDelivery(req, reply, share.file);
      if (!ctx) return reply;
      // Range continuations of an already-counted download do not consume another download.
      const continuation = typeof req.headers.range === 'string' && !/^bytes=0-/.test(req.headers.range);
      if (!continuation && req.method === 'GET') {
        if (!(await consumeDownload(share))) throw new AppError('share_expired', 'This share link has reached its download limit.');
        await recordShareAccess(req, share, { downloaded: true });
        const zone = ctx.zone;
        void emitWebhookEvent('share.downloaded', { share_id: share.id, file_id: share.fileId, country: req.country }, { projectId: zone?.projectId });
      }
      return sendFile(req, reply, share.file, { disposition: 'attachment', privateResponse: true, ctx, kind: 'share' });
    },
  }),

  // ─── Management ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/shares',
    tag: 'Shares',
    summary: 'Create a share link',
    description:
      'Creates a human-friendly share URL for a file — works for private files without handing out API keys. Optional password, expiry, download limit, one-time use, IP / country restrictions and email capture. The URL (with its secret token) is only returned once.',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    params: z.object({ id: z.string().max(64) }),
    body: z.object({ ...shareOptions, password: z.string().min(4).max(256).optional(), one_time: z.boolean().default(false), expires_in: z.number().int().min(60).max(365 * 86_400).optional() }),
    responses: { 201: { description: 'Share link (url shown once)' } },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed'],
    async handler({ req, reply, params, body }) {
      const file = await requireFile(req, params.id);
      if (file.status !== 'READY') throw new AppError('file_not_ready');
      const token = randomBase62(32);
      const expiresAt = body.expires_at ?? (body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null);
      if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('validation_failed', 'expires_at must be in the future.');
      const share = await getPrisma().shareLink.create({
        data: {
          id: newId('shareLink'),
          fileId: file.id,
          tokenHash: sha256Hex(token),
          tokenPrefix: token.slice(0, 6),
          title: body.title ?? null,
          message: body.message ?? null,
          passwordHash: body.password ? await hashPassword(body.password) : null,
          expiresAt,
          maxDownloads: body.one_time ? 1 : (body.max_downloads ?? null),
          oneTime: body.one_time,
          allowedIps: body.allowed_ips ?? [],
          allowedCountries: body.allowed_countries ?? [],
          requireEmail: body.require_email ?? false,
          createdById: userIdOf(req),
          createdByApiKeyId: apiKeyIdOf(req),
        },
        include: { file: { select: { id: true, name: true } } },
      });
      const url = await shareUrl(share, token);
      await audit(actorOf(req), 'SHARE_CREATE', { type: 'share_link', id: share.id }, { file_id: file.id, expires_at: expiresAt, one_time: body.one_time, password: Boolean(body.password) });
      void emitWebhookEvent('share.created', { share_id: share.id, file_id: file.id, expires_at: expiresAt?.toISOString() ?? null });
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return serializeShare(share, url);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/shares',
    tag: 'Shares',
    summary: 'List share links',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    query: pageQuery.extend({ file_id: z.string().optional(), state: z.enum(['active', 'inactive', 'all']).default('all') }),
    async handler({ req, query }) {
      const prisma = getPrisma();
      const and: Prisma.ShareLinkWhereInput[] = [];
      if (query.file_id) and.push({ fileId: (await requireFile(req, query.file_id, { includeDeleted: true })).id });
      if (query.state === 'active') and.push({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });
      if (query.state === 'inactive') and.push({ OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: new Date() } }] });
      if (req.auth?.type === 'api_key' && req.auth.apiKey.projectId) {
        const { projectFileFilter } = await import('../lib/folders.js');
        const f = await projectFileFilter(req);
        if (f) and.push({ file: f });
      }
      const where = { AND: and };
      const [total, rows] = await Promise.all([
        prisma.shareLink.count({ where }),
        prisma.shareLink.findMany({ where, include: { file: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(rows.map((s) => serializeShare(s)), total, query.page, query.limit);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/shares/:id',
    tag: 'Shares',
    summary: 'Get a share link with its access log',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    params: z.object({ id: z.string() }),
    errors: ['share_not_found'],
    async handler({ req, params }) {
      const share = await requireShare(req, params.id);
      const accesses = await getPrisma().shareAccess.findMany({ where: { shareLinkId: share.id }, orderBy: { timestamp: 'desc' }, take: 200 });
      return {
        ...serializeShare(share),
        accesses: accesses.map((a) => ({ timestamp: a.timestamp.toISOString(), email: a.email, ip: a.ip, country: a.country, user_agent: a.userAgent, downloaded: a.downloaded })),
      };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/shares/:id',
    tag: 'Shares',
    summary: 'Update a share link',
    description: 'Changes limits and restrictions. Pass `password: null` to remove the password.',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    params: z.object({ id: z.string() }),
    body: z.object({ ...shareOptions, password: z.string().min(4).max(256).nullable().optional() }).strict(),
    errors: ['share_not_found'],
    async handler({ req, params, body }) {
      const share = await requireShare(req, params.id);
      const data: Prisma.ShareLinkUpdateInput = {
        title: body.title,
        message: body.message,
        expiresAt: body.expires_at,
        maxDownloads: share.oneTime ? undefined : body.max_downloads,
        allowedIps: body.allowed_ips,
        allowedCountries: body.allowed_countries,
        requireEmail: body.require_email,
      };
      if (body.password !== undefined) data.passwordHash = body.password === null ? null : await hashPassword(body.password);
      const updated = await getPrisma().shareLink.update({ where: { id: share.id }, data, include: { file: { select: { id: true, name: true } } } });
      await audit(actorOf(req), 'SHARE_UPDATE', { type: 'share_link', id: share.id }, { changes: { ...body, password: body.password === undefined ? undefined : '[changed]' } });
      return serializeShare(updated);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/shares/:id/revoke',
    tag: 'Shares',
    summary: 'Revoke a share link',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    params: z.object({ id: z.string() }),
    errors: ['share_not_found'],
    async handler({ req, params }) {
      const share = await requireShare(req, params.id);
      const updated = await getPrisma().shareLink.update({ where: { id: share.id }, data: { revokedAt: share.revokedAt ?? new Date() }, include: { file: { select: { id: true, name: true } } } });
      await audit(actorOf(req), 'SHARE_REVOKE', { type: 'share_link', id: share.id }, { file_id: share.fileId });
      return serializeShare(updated);
    },
  }),
];
