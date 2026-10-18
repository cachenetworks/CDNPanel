import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma, Prisma, type File, type ShareLink } from '@cdn/database';
import { AppError, isValidId, newId, randomBase62, sha256Hex } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { projectFileFilter, projectFolderFilter, requireFolder } from '../lib/folders.js';
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
  findSharedFolderFile,
  isUnlocked,
  listSharedFolderFiles,
  needsUnlock,
  recordShareAccess,
  renderSharePage,
  sendHtml,
  setUnlocked,
  shareState,
  type ShareWithTarget,
} from '../services/shares.js';

const tokenParams = z.object({ token: z.string().max(64) });

async function shareUrl(share: { fileId: string | null; folderId: string | null }, token: string): Promise<string> {
  const file = share.fileId ? await getPrisma().file.findUnique({ where: { id: share.fileId }, select: { folderId: true } }) : null;
  const zone = zoneForPath(await getZones(), await folderPathOf(share.folderId ?? file?.folderId ?? null));
  return `${zoneBaseUrl(zone, env().CDN_URL)}/s/${token}`;
}

const shareInclude = { file: { select: { id: true, name: true } }, folder: { select: { id: true, name: true, path: true } } } as const;

export function serializeShare(s: ShareLink & { file?: { id: string; name: string } | null; folder?: { id: string; name: string; path: string } | null }, url?: string) {
  return {
    id: s.id,
    object: 'share_link' as const,
    target: s.folderId ? ('folder' as const) : ('file' as const),
    file_id: s.fileId,
    file: s.file ? { id: s.file.id, name: s.file.name } : undefined,
    folder_id: s.folderId,
    folder: s.folder ? { id: s.folder.id, name: s.folder.name, path: s.folder.path } : undefined,
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
  const share = await getPrisma().shareLink.findUnique({ where: { id }, include: shareInclude });
  if (!share) throw new AppError('share_not_found');
  if (share.folderId) await requireFolder(req, share.folderId);
  else await requireFile(req, share.fileId!, { includeDeleted: true });
  return share;
}

/** Streams a file through a share link, counting the download (shared by file and folder shares). */
async function deliverShared(req: FastifyRequest, reply: FastifyReply, share: ShareWithTarget, file: File, token: string) {
  assertShareAccess(req, share);
  if (needsUnlock(share) && !isUnlocked(req, share)) {
    if (req.headers.accept?.includes('text/html')) return reply.redirect(`/s/${token}`, 303);
    throw new AppError('share_password_required');
  }
  const ctx = await prepareDelivery(req, reply, file);
  if (!ctx) return reply;
  // Range continuations of an already-counted download do not consume another download.
  const continuation = typeof req.headers.range === 'string' && !/^bytes=0-/.test(req.headers.range);
  if (!continuation && req.method === 'GET') {
    if (!(await consumeDownload(share))) throw new AppError('share_expired', 'This share link has reached its download limit.');
    await recordShareAccess(req, share, { downloaded: true });
    void emitWebhookEvent('share.downloaded', { share_id: share.id, file_id: file.id, folder_id: share.folderId, country: req.country }, { projectId: ctx.zone?.projectId });
  }
  return sendFile(req, reply, file, { disposition: 'attachment', privateResponse: true, ctx, kind: 'share' });
}

/** Builds a share link row for a file or a folder from the create body. */
async function createShare(req: FastifyRequest, target: { fileId: string } | { folderId: string }, body: z.infer<typeof createBody>) {
  const token = randomBase62(32);
  const expiresAt = body.expires_at ?? (body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null);
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('validation_failed', 'expires_at must be in the future.');
  const share = await getPrisma().shareLink.create({
    data: {
      id: newId('shareLink'),
      ...target,
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
    include: shareInclude,
  });
  const url = await shareUrl(share, token);
  await audit(actorOf(req), 'SHARE_CREATE', { type: 'share_link', id: share.id }, { file_id: share.fileId, folder_id: share.folderId, expires_at: expiresAt, one_time: body.one_time, password: Boolean(body.password) });
  void emitWebhookEvent('share.created', { share_id: share.id, file_id: share.fileId, folder_id: share.folderId, expires_at: expiresAt?.toISOString() ?? null });
  return serializeShare(share, url);
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

const createBody = z.object({ ...shareOptions, password: z.string().min(4).max(256).optional(), one_time: z.boolean().default(false), expires_in: z.number().int().min(60).max(365 * 86_400).optional() });

export const shareRoutes: RouteDef<any, any, any>[] = [
  // ─── Public ───
  defineRoute({
    method: 'GET',
    url: '/s/:token',
    tag: 'Shares',
    summary: 'Share landing page',
    description: 'Human-facing page for a share link: shows the file (or the files of a shared folder), asks for the password / email when required and offers the download.',
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
      // A share landing GET counts as a click, independently of file delivery.
      req.analytics = share.file ? { fileId: share.file.id, kind: 'share', trafficType: 'click' } : { kind: 'share' };
      const files = share.folder ? await listSharedFolderFiles(share.folder) : undefined;
      return sendHtml(reply, renderSharePage({ siteName: settings.general.siteName, share, token: params.token, unlocked: isUnlocked(req, share), files }));
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
      const files = share.folder ? await listSharedFolderFiles(share.folder) : undefined;
      const render = (error: string, status: number) => sendHtml(reply, renderSharePage({ siteName: settings.general.siteName, share, token: params.token, unlocked: false, files, error }), status);
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
      // Folder shares are downloaded file by file from the landing page.
      if (share.folder) {
        if (req.headers.accept?.includes('text/html')) return reply.redirect(`/s/${params.token}`, 303);
        throw new AppError('share_not_found', 'This is a folder share; download its files individually.');
      }
      return deliverShared(req, reply, share, share.file, params.token);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/s/:token/files/:fileId',
    tag: 'Shares',
    summary: 'Download a file through a folder share link',
    description: 'Streams one file of a shared folder (or its sub-folders) as an attachment. Each file download counts towards the download limit.',
    auth: 'public',
    params: tokenParams.extend({ fileId: z.string().max(64) }),
    responses: { 200: { description: 'File content', contentType: 'application/octet-stream' } },
    errors: ['share_not_found', 'share_expired', 'share_password_required', 'access_denied'],
    async handler({ req, reply, params }) {
      const share = await findShareByToken(params.token);
      if (!share.folder) throw new AppError('share_not_found');
      assertShareAccess(req, share);
      const file = await findSharedFolderFile(share.folder, params.fileId);
      return deliverShared(req, reply, share, file, params.token);
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
    body: createBody,
    responses: { 201: { description: 'Share link (url shown once)' } },
    errors: ['file_not_found', 'file_not_ready', 'validation_failed'],
    async handler({ req, reply, params, body }) {
      const file = await requireFile(req, params.id);
      if (file.status !== 'READY') throw new AppError('file_not_ready');
      const share = await createShare(req, { fileId: file.id }, body);
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return share;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/folders/:id/shares',
    tag: 'Shares',
    summary: 'Share a folder',
    description:
      'Creates a share URL for a whole folder: the landing page lists every ready file in the folder and its sub-folders, each downloadable on its own. Sub-folders restricted to staff roles are not exposed. Same options as file shares except one-time use; the download limit counts file downloads. The URL is only returned once.',
    auth: 'any',
    permission: 'shares.manage',
    scope: 'shares:write',
    params: z.object({ id: z.string().max(64) }),
    body: createBody,
    responses: { 201: { description: 'Share link (url shown once)' } },
    errors: ['folder_not_found', 'validation_failed'],
    async handler({ req, reply, params, body }) {
      const folder = await requireFolder(req, params.id);
      if (body.one_time) throw new AppError('validation_failed', 'Folder shares cannot be one-time; use a download limit instead.');
      const share = await createShare(req, { folderId: folder.id }, body);
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return share;
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
    query: pageQuery.extend({ file_id: z.string().optional(), folder_id: z.string().optional(), state: z.enum(['active', 'inactive', 'all']).default('all') }),
    async handler({ req, query }) {
      const prisma = getPrisma();
      const and: Prisma.ShareLinkWhereInput[] = [];
      if (query.file_id) and.push({ fileId: (await requireFile(req, query.file_id, { includeDeleted: true })).id });
      if (query.folder_id) and.push({ folderId: (await requireFolder(req, query.folder_id)).id });
      if (query.state === 'active') and.push({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });
      if (query.state === 'inactive') and.push({ OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: new Date() } }] });
      if (req.auth?.type === 'api_key' && req.auth.apiKey.projectId) {
        const [files, folders] = await Promise.all([projectFileFilter(req), projectFolderFilter(req)]);
        if (files && folders) and.push({ OR: [{ file: files }, { folder: folders }] });
      }
      const where = { AND: and };
      const [total, rows] = await Promise.all([
        prisma.shareLink.count({ where }),
        prisma.shareLink.findMany({ where, include: shareInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
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
      const updated = await getPrisma().shareLink.update({ where: { id: share.id }, data, include: shareInclude });
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
      const updated = await getPrisma().shareLink.update({ where: { id: share.id }, data: { revokedAt: share.revokedAt ?? new Date() }, include: shareInclude });
      await audit(actorOf(req), 'SHARE_REVOKE', { type: 'share_link', id: share.id }, { file_id: share.fileId, folder_id: share.folderId });
      return serializeShare(updated);
    },
  }),
];
