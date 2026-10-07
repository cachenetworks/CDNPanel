import type { FastifyReply, FastifyRequest } from 'fastify';
import type { File } from '@cdn/database';
import { AppError, isActiveContentType, verifySignedFileUrl } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';

/**
 * Visibility enforcement for file delivery.
 *  PUBLIC          – anyone
 *  AUTHENTICATED   – any valid API key or staff session, or a valid signed URL
 *  PRIVATE         – API key with files:read, staff with files.download, or a valid signed URL
 *  SIGNED_URL_ONLY – only a valid signed URL
 * A signature, when present, is always verified — an invalid one is rejected even for public files.
 */
export function authorizeDelivery(req: FastifyRequest, file: Pick<File, 'id' | 'visibility'>): { signedDisposition?: 'inline' | 'attachment' } {
  const q = req.query as Record<string, unknown>;
  if (q.sig !== undefined || q.expires !== undefined) {
    const result = verifySignedFileUrl(getKeyring(), file.id, q);
    if (!result.ok) {
      void securityEvent('SIGNED_URL_INVALID', { ip: req.clientIp, severity: 'info', details: { file_id: file.id, reason: result.reason } });
      throw new AppError(result.reason);
    }
    return { signedDisposition: result.disposition };
  }
  const auth = req.auth;
  switch (file.visibility) {
    case 'PUBLIC':
      return {};
    case 'AUTHENTICATED':
      if (!auth) throw new AppError('unauthenticated');
      if (auth.type === 'session' && !auth.permissions.has('files.view')) throw new AppError('forbidden');
      return {};
    case 'PRIVATE':
      if (!auth) throw new AppError('unauthenticated');
      if (auth.type === 'api_key' ? !auth.scopes.has('files:read') : !auth.permissions.has('files.download')) {
        throw new AppError(auth.type === 'api_key' ? 'insufficient_scope' : 'forbidden');
      }
      return {};
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

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

export interface SendOptions {
  disposition?: 'inline' | 'attachment';
  /** Authorised API download route: never publicly cacheable. */
  privateResponse?: boolean;
}

/** Streams a file with full HTTP caching / range semantics. */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, file: File, opts: SendOptions = {}): Promise<FastifyReply> {
  const settings = await getSettings();
  const size = Number(file.size);
  const etag = `"${file.sha256 ?? file.id}"`;
  const lastModified = file.createdAt;
  const active = isActiveContentType(file.mimeType);
  const forceAttachment = file.forceDownload || (active && settings.files.forceDownloadActiveContent);
  const disposition = forceAttachment ? 'attachment' : (opts.disposition ?? 'inline');
  const isPublic = file.visibility === 'PUBLIC' && !opts.privateResponse;
  const cacheControl = isPublic ? (file.cacheControl ?? settings.files.defaultCacheControl) : settings.files.privateCacheControl;

  req.analytics = { fileId: file.id, folderId: file.folderId, mimeType: file.mimeType, cacheStatus: 'origin' };

  const type = file.mimeType.startsWith('text/') || file.mimeType === 'application/json' ? `${file.mimeType}; charset=utf-8` : file.mimeType;
  reply.header('Content-Type', type);
  reply.header('ETag', etag);
  reply.header('Last-Modified', lastModified.toUTCString());
  reply.header('Cache-Control', cacheControl);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', contentDisposition(disposition, file.name));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Resource-Policy', isPublic ? 'cross-origin' : 'same-site');
  if (!isPublic) reply.header('Vary', 'Authorization');
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
  const { driver } = await driverForId(file.storageProviderId);
  if (e.DELIVERY_MODE === 'x-accel' && driver.resolvePath) {
    // Nginx serves the bytes (incl. ranges) from the internal location; authorization already passed.
    reply.removeHeader('Content-Length');
    reply.removeHeader('Content-Range');
    reply.header('X-Accel-Redirect', `${e.X_ACCEL_PREFIX}/${file.storageKey}`);
    reply.header('X-Accel-Buffering', 'no');
    return reply.code(200).send();
  }
  if (e.DELIVERY_MODE === 'redirect' && driver.presignGet) {
    const ttl = isPublic ? 3600 : 300;
    const url = await driver.presignGet(file.storageKey, {
      expiresIn: ttl,
      contentType: type,
      contentDisposition: contentDisposition(disposition, file.name),
      cacheControl,
    });
    reply.removeHeader('Content-Length');
    reply.removeHeader('Content-Range');
    reply.header('Cache-Control', 'private, no-store');
    req.analytics.cacheStatus = 'redirect';
    return reply.redirect(url, 302);
  }

  const stream = await driver.get(file.storageKey, range ? { start: range.start, end: range.end } : undefined);
  stream.on('error', (err) => req.log.error({ err, file_id: file.id }, 'storage stream error'));
  return reply.code(status).send(stream);
}
