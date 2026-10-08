import type { FastifyReply, FastifyRequest } from 'fastify';
import type { File } from '@cdn/database';
import { AppError, hmacSha256, isActiveContentType, safeEqual, verifySignedFileUrl } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { folderPathOf, getZones, zoneForHost, zoneForPath, type ZoneWithRelations } from '../lib/zones.js';
import { cachePolicy, zoneRelativePath } from './cachePolicy.js';
import { enforceEdgeSecurity } from './edgeSecurity.js';
import { openFileStream, sourceCandidates } from './replication.js';
import { assertDeliveryQuota } from './usage.js';

// ─── Signed cookies ─────────────────────────────────────────────────────────

export const SIGNED_COOKIE = 'cdn_access';

/**
 * Signed cookies grant time-limited access to every file under a folder path ("protected
 * collections"), e.g. a members-only gallery, without signing each URL.
 * Format: v1.<expires>.<base64url(path prefix)>.<key version>.<signature>
 */
export function signAccessCookie(pathPrefix: string, expiresInSeconds: number): { value: string; expires: number } {
  const keyring = getKeyring();
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const p = Buffer.from(pathPrefix).toString('base64url');
  const kv = keyring.currentVersion;
  const sig = hmacSha256(keyring.subkey('signed-cookie', kv), `v1\n${expires}\n${pathPrefix}`).toString('base64url');
  return { value: `v1.${expires}.${p}.${kv}.${sig}`, expires };
}

export function verifyAccessCookie(value: string | undefined, folderPath: string | null): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return false;
  const [, expRaw, p, kvRaw, sig] = parts as [string, string, string, string, string];
  const exp = Number(expRaw);
  const kv = Number(kvRaw);
  const keyring = getKeyring();
  if (!Number.isInteger(exp) || !Number.isInteger(kv) || !keyring.hasVersion(kv) || exp < Date.now() / 1000) return false;
  const prefix = Buffer.from(p, 'base64url').toString();
  const expected = hmacSha256(keyring.subkey('signed-cookie', kv), `v1\n${exp}\n${prefix}`).toString('base64url');
  if (!safeEqual(expected, sig)) return false;
  const path = folderPath ?? '';
  return prefix === '/' || path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`);
}

// ─── Authorization ──────────────────────────────────────────────────────────

/**
 * Visibility enforcement for file delivery.
 *  PUBLIC          – anyone
 *  AUTHENTICATED   – any valid API key or staff session, a signed URL or a signed cookie
 *  PRIVATE         – API key with files:read, staff with files.download, a signed URL or a signed cookie
 *  SIGNED_URL_ONLY – only a valid signed URL
 * A signature, when present, is always verified — an invalid one is rejected even for public files.
 */
export function authorizeDelivery(req: FastifyRequest, file: Pick<File, 'id' | 'visibility'>, folderPath: string | null = null): { signedDisposition?: 'inline' | 'attachment'; via: string } {
  const q = req.query as Record<string, unknown>;
  if (q.sig !== undefined || q.expires !== undefined) {
    const result = verifySignedFileUrl(getKeyring(), file.id, q);
    if (!result.ok) {
      void securityEvent('SIGNED_URL_INVALID', { ip: req.clientIp, severity: 'info', details: { file_id: file.id, reason: result.reason } });
      throw new AppError(result.reason);
    }
    return { signedDisposition: result.disposition, via: 'signed_url' };
  }
  const auth = req.auth;
  const cookieOk = () => verifyAccessCookie(req.cookies?.[SIGNED_COOKIE], folderPath);
  switch (file.visibility) {
    case 'PUBLIC':
      return { via: 'public' };
    case 'AUTHENTICATED':
      if (cookieOk()) return { via: 'signed_cookie' };
      if (!auth) throw new AppError('unauthenticated');
      if (auth.type === 'session' && !auth.permissions.has('files.view')) throw new AppError('forbidden');
      return { via: auth.type };
    case 'PRIVATE':
      if (cookieOk()) return { via: 'signed_cookie' };
      if (!auth) throw new AppError('unauthenticated');
      if (auth.type === 'api_key' ? !auth.scopes.has('files:read') : !auth.permissions.has('files.download')) {
        throw new AppError(auth.type === 'api_key' ? 'insufficient_scope' : 'forbidden');
      }
      return { via: auth.type };
    case 'SIGNED_URL_ONLY':
      throw new AppError('invalid_signature', 'This file is only available through a signed URL.');
  }
}

export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

interface ParsedRange {
  start: number;
  end: number;
}

/** Parses a single `bytes=` range. Returns null for absent/unsupported (multi-range) headers. */
export function parseRange(header: string | undefined, size: number): ParsedRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multiple ranges or other units: serve the full entity
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
    const suffix = Number(e);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

export function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

// ─── Public delivery pipeline ───────────────────────────────────────────────

export interface DeliveryContext {
  zone: ZoneWithRelations | null;
  folderPath: string | null;
  relPath: string;
}

/**
 * Resolves the zone of a file and applies everything that must happen before bytes are served on
 * public delivery routes: cross-zone isolation on custom domains, disabled zones, edge security
 * (geo / hotlink / WAF rules / challenges), hard quotas.
 * Returns null when a response (challenge page) was already sent.
 */
export async function prepareDelivery(
  req: FastifyRequest,
  reply: FastifyReply,
  file: Pick<File, 'id' | 'folderId' | 'slug'>,
  metric: 'egress_bytes' | 'transforms' = 'egress_bytes',
): Promise<DeliveryContext | null> {
  const reg = await getZones();
  const folderPath = await folderPathOf(file.folderId);
  const zone = zoneForPath(reg, folderPath);
  const hostZone = await zoneForHost(req.headers.host);
  // A custom domain only serves its own zone's files.
  if (hostZone && hostZone.id !== zone?.id) throw new AppError('file_not_found');
  if (zone && !zone.enabled) throw new AppError('file_not_found');
  if (await enforceEdgeSecurity(req, reply, zone)) return null;
  await assertDeliveryQuota(zone, req.auth?.type === 'api_key' ? req.auth.apiKey.id : null, metric);
  return { zone, folderPath, relPath: zoneRelativePath(folderPath, file.slug, zone) };
}

export interface SendOptions {
  disposition?: 'inline' | 'attachment';
  /** Authorised API download route: never publicly cacheable. */
  privateResponse?: boolean;
  /** Zone context from prepareDelivery (resolved here when omitted). */
  ctx?: DeliveryContext;
  /** Overrides analytics kind (share downloads). */
  kind?: 'delivery' | 'share';
}

/** Streams a file with full HTTP caching / range semantics. */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, file: File, opts: SendOptions = {}): Promise<FastifyReply> {
  const settings = await getSettings();
  let ctx = opts.ctx;
  if (!ctx) {
    const folderPath = await folderPathOf(file.folderId);
    const zone = zoneForPath(await getZones(), folderPath);
    ctx = { zone, folderPath, relPath: zoneRelativePath(folderPath, file.slug, zone) };
  }
  const size = Number(file.size);
  const etag = `"${file.sha256 ?? file.id}"`;
  const lastModified = file.version > 1 ? file.updatedAt : file.createdAt;
  const active = isActiveContentType(file.mimeType);
  const forceAttachment = file.forceDownload || (active && settings.files.forceDownloadActiveContent);
  const disposition = forceAttachment ? 'attachment' : (opts.disposition ?? 'inline');
  const isPublic = file.visibility === 'PUBLIC' && !opts.privateResponse;
  const policy = cachePolicy({ file, zone: ctx.zone, relPath: ctx.relPath, settings, isPublic });

  req.analytics = {
    fileId: file.id,
    folderId: file.folderId,
    mimeType: file.mimeType,
    cacheStatus: 'origin',
    zoneId: ctx.zone?.id ?? null,
    projectId: ctx.zone?.projectId ?? null,
    kind: opts.kind ?? 'delivery',
  };

  const type = file.mimeType.startsWith('text/') || file.mimeType === 'application/json' ? `${file.mimeType}; charset=utf-8` : file.mimeType;
  reply.header('Content-Type', type);
  reply.header('ETag', etag);
  reply.header('Last-Modified', lastModified.toUTCString());
  reply.header('Cache-Control', policy.cacheControl);
  if (policy.cdnCacheControl) reply.header('CDN-Cache-Control', policy.cdnCacheControl);
  if (isPublic) reply.header('Cache-Tag', policy.tags.join(','));
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', contentDisposition(disposition, file.name));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Resource-Policy', isPublic ? 'cross-origin' : 'same-site');
  if (!isPublic) reply.header('Vary', 'Authorization, Cookie');
  if (ctx.zone) reply.header('X-CDN-Zone', ctx.zone.slug);
  // Uploaded HTML/SVG/etc. must never execute with an origin: sandbox it.
  reply.header('Content-Security-Policy', active ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  reply.header('X-Frame-Options', active ? 'DENY' : 'SAMEORIGIN');

  // Conditional requests (RFC 9110 §13.2.2 precedence)
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  if (ifNoneMatch ? etagMatches(ifNoneMatch, etag) : ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(lastModified.getTime() / 1000) * 1000) {
    req.analytics.cacheStatus = 'revalidated';
    return reply.code(304).send();
  }
  const ifMatch = req.headers['if-match'];
  if (ifMatch && !etagMatches(ifMatch, etag)) {
    return reply.code(412).header('Content-Type', 'application/json').send({ error: { code: 'precondition_failed', message: 'Precondition failed.', request_id: req.id } });
  }

  let range = parseRange(req.headers.range, size);
  const ifRange = req.headers['if-range'];
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified.toUTCString()) range = null;
  if (range === 'unsatisfiable') {
    reply.header('Content-Range', `bytes */${size}`);
    throw new AppError('range_not_satisfiable');
  }

  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : size;
  if (range) {
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    req.analytics.cacheStatus = range.start === 0 ? 'range-start' : 'range';
  }
  reply.header('Content-Length', String(length));
  req.analytics.bytes = req.method === 'HEAD' ? 0 : length;

  if (req.method === 'HEAD') {
    // Write the head directly so the computed Content-Length is preserved (no body is sent).
    reply.hijack();
    reply.raw.writeHead(status, reply.getHeaders() as Record<string, string>);
    reply.raw.end();
    return reply;
  }

  const e = env();
  const candidates = await sourceCandidates(file, ctx.zone, req.country);
  const first = candidates[0]!;
  const { driver } = await driverForId(first.providerId);
  if (first.role === 'replica') reply.header('X-CDN-Source', 'replica');
  if (e.DELIVERY_MODE === 'x-accel' && driver.resolvePath && candidates.length === 1) {
    // Nginx serves the bytes (incl. ranges) from the internal location; authorization already passed.
    reply.removeHeader('Content-Length');
    reply.removeHeader('Content-Range');
    reply.header('X-Accel-Redirect', `${e.X_ACCEL_PREFIX}/${first.key}`);
    reply.header('X-Accel-Buffering', 'no');
    return reply.code(200).send();
  }
  if (e.DELIVERY_MODE === 'redirect' && driver.presignGet) {
    const ttl = isPublic ? 3600 : 300;
    const url = await driver.presignGet(first.key, {
      expiresIn: ttl,
      contentType: type,
      contentDisposition: contentDisposition(disposition, file.name),
      cacheControl: policy.cacheControl,
    });
    reply.removeHeader('Content-Length');
    reply.removeHeader('Content-Range');
    reply.header('Cache-Control', 'private, no-store');
    req.analytics.cacheStatus = 'redirect';
    return reply.redirect(url, 302);
  }

  const { stream } = await openFileStream(file, range ? { start: range.start, end: range.end } : null, candidates);
  stream.on('error', (err) => req.log.error({ err, file_id: file.id }, 'storage stream error'));
  return reply.code(status).send(stream);
}
