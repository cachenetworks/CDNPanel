import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma, type File } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { env } from '../config/env.js';
import { getSettings } from '../lib/settings.js';
import { zoneForHost, normalizeHost } from '../lib/zones.js';
import { authorizeDelivery, prepareDelivery, sendFile, SIGNED_COOKIE, verifyAccessCookie } from '../services/delivery.js';
import { verifyChallenge } from '../services/edgeSecurity.js';

const deliveryQuery = z.object({
  expires: z.string().optional().describe('Signed URL expiry (unix seconds).'),
  kv: z.string().optional().describe('Signing key version.'),
  disposition: z.enum(['inline', 'attachment']).optional(),
  sig: z.string().optional().describe('Signed URL signature.'),
  download: z.enum(['1', 'true']).optional().describe('Serve as an attachment.'),
});

type DeliveryQuery = z.infer<typeof deliveryQuery>;

function splitPath(raw: string): string[] {
  let segments: string[];
  try {
    segments = raw.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    throw new AppError('not_found');
  }
  if (segments.length === 0 || segments.length > 32) throw new AppError('not_found');
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\0') || s.length > 255)) throw new AppError('not_found');
  return segments;
}

/** Resolves "<folder path>/<file slug>" beneath `basePath` ('' = library root). */
export async function resolveFileByPath(basePath: string, segments: string[]): Promise<File> {
  const parts = [...segments];
  const slug = parts.pop()!;
  const prisma = getPrisma();
  const folderPath = `${basePath}${parts.length ? `/${parts.join('/')}` : ''}`;
  let folderId: string | null = null;
  if (folderPath) {
    const folder = await prisma.folder.findUnique({ where: { path: folderPath } });
    if (!folder) throw new AppError('file_not_found');
    folderId = folder.id;
  }
  const file = await prisma.file.findFirst({ where: { folderId, slug, status: 'READY', deletedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!file) throw new AppError('file_not_found');
  return file;
}

async function deliver(req: FastifyRequest, reply: FastifyReply, file: File, query: DeliveryQuery) {
  const ctx = await prepareDelivery(req, reply, file);
  if (!ctx) return reply;
  const { signedDisposition } = authorizeDelivery(req, file, ctx.folderPath);
  const disposition = query.download ? 'attachment' : (signedDisposition ?? query.disposition ?? 'inline');
  return sendFile(req, reply, file, { disposition, ctx });
}

export const deliveryRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/files/:id',
    tag: 'Delivery',
    summary: 'Serve a file (CDN)',
    description:
      'Public CDN delivery endpoint (also answers `HEAD`). Public files are served to anyone. Private / authenticated files require an `Authorization: Bearer` API key, a valid signed URL or a signed access cookie; `SIGNED_URL_ONLY` files require a signed URL. Zone rules apply: geo / hotlink restrictions, security rules, cache rules (`Cache-Control` for browsers, `CDN-Cache-Control` for the edge, `Cache-Tag` for purges) and replication-aware origin selection. Supports `Range` (206), conditional requests (304), `ETag` and `Last-Modified`.',
    auth: 'public',
    params: z.object({ id: z.string().max(64) }),
    query: deliveryQuery,
    responses: {
      200: { description: 'File content', contentType: 'application/octet-stream' },
      206: { description: 'Partial content', contentType: 'application/octet-stream' },
      304: { description: 'Not modified' },
    },
    errors: ['file_not_found', 'invalid_id', 'unauthenticated', 'invalid_signature', 'signature_expired', 'range_not_satisfiable', 'rate_limited', 'access_denied', 'quota_exceeded'],
    async handler({ req, reply, params, query }) {
      if (!isValidId('file', params.id)) throw new AppError('invalid_id', 'The file id is malformed.');
      const file = await getPrisma().file.findUnique({ where: { id: params.id } });
      if (!file || file.status !== 'READY' || file.deletedAt) throw new AppError('file_not_found');
      return deliver(req, reply, file, query);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/p/*',
    tag: 'Delivery',
    summary: 'Serve a file by friendly path',
    description:
      'Friendly URLs such as `https://cdn.example.com/p/assets/logo.png` resolve the folder path and file slug. Only enabled when "friendly paths" is on in settings. Visibility and zone rules are identical to `/files/{id}`.',
    auth: 'public',
    query: deliveryQuery,
    responses: { 200: { description: 'File content', contentType: 'application/octet-stream' } },
    errors: ['file_not_found', 'unauthenticated', 'invalid_signature', 'access_denied'],
    async handler({ req, reply, query }) {
      const settings = await getSettings();
      const raw = (req.params as { '*': string })['*'] ?? '';
      if (!settings.files.enableFriendlyPaths || !raw) throw new AppError('not_found');
      const file = await resolveFileByPath('', splitPath(raw));
      return deliver(req, reply, file, query);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/_zone/*',
    tag: 'Delivery',
    summary: 'Serve a file on a custom domain',
    description:
      'On a verified zone hostname, paths resolve relative to the zone root folder: `https://assets.example.com/img/logo.png` serves `<zone root>/img/logo.png`. Nginx rewrites requests for zone hostnames to this route; it is not called directly.',
    auth: 'public',
    query: deliveryQuery,
    hidden: true,
    errors: ['file_not_found', 'access_denied'],
    async handler({ req, reply, query }) {
      const zone = await zoneForHost(req.headers.host);
      if (!zone) throw new AppError('not_found');
      const raw = (req.params as { '*': string })['*'] ?? '';
      if (!raw || raw === '/') throw new AppError('file_not_found');
      const file = await resolveFileByPath(zone.rootFolder?.path ?? '', splitPath(raw));
      return deliver(req, reply, file, query);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/.well-known/cdnpanel/:id',
    tag: 'Delivery',
    summary: 'Domain ownership probe',
    description: 'Answers the HTTPS reachability probe used by domain health checks with the domain verification token.',
    auth: 'public',
    hidden: true,
    params: z.object({ id: z.string().max(64) }),
    async handler({ req, reply, params }) {
      if (!isValidId('domain', params.id)) throw new AppError('not_found');
      const domain = await getPrisma().zoneDomain.findUnique({ where: { id: params.id } });
      if (!domain || domain.hostname !== normalizeHost(req.headers.host)) throw new AppError('not_found');
      reply.header('Cache-Control', 'no-store').type('text/plain; charset=utf-8');
      return domain.verificationToken;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/_challenge/verify',
    tag: 'Delivery',
    summary: 'Complete a browser challenge',
    auth: 'public',
    hidden: true,
    skipCsrf: true,
    body: z.object({ nonce: z.string().max(300), counter: z.string().max(20) }),
    rateLimit: { name: 'challenge', max: 30, windowSeconds: 60 },
    async handler({ req, reply, body }) {
      if (!(await verifyChallenge(req, reply, body.nonce, body.counter))) throw new AppError('challenge_required');
      reply.header('Cache-Control', 'no-store');
      return { ok: true };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/_auth/cookie',
    tag: 'Delivery',
    summary: 'Install a signed access cookie',
    description:
      'Sets a signed access cookie (issued by `POST /api/v1/signed-cookies`) on the CDN hostname, then redirects to `redirect` (a path on the same host). Lets protected collections be browsed with plain URLs.',
    auth: 'public',
    query: z.object({ token: z.string().max(600), redirect: z.string().max(2000).default('/') }),
    responses: { 302: { description: 'Redirect after the cookie is set' } },
    errors: ['invalid_signature'],
    async handler({ reply, query }) {
      const parts = query.token.split('.');
      const exp = Number(parts[1]);
      // Verify against the token's own prefix (any path inside it).
      const prefix = parts[2] ? Buffer.from(parts[2], 'base64url').toString() : '';
      if (!verifyAccessCookie(query.token, prefix || '/')) throw new AppError('invalid_signature');
      const target = query.redirect.startsWith('/') && !query.redirect.startsWith('//') ? query.redirect : '/';
      reply.setCookie(SIGNED_COOKIE, query.token, {
        httpOnly: true,
        secure: env().cookieSecure,
        sameSite: 'lax',
        path: '/',
        expires: new Date(exp * 1000),
      });
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(target, 302);
    },
  }),
];
