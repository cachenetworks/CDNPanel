import type { FastifyRequest } from 'fastify';
import { AppError, hmacSha256, safeEqual } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import type { SessionAuth } from './context.js';
import { securityEvent } from '../lib/audit.js';

/**
 * CSRF protection for cookie-authenticated requests:
 *  1. The CSRF token is HMAC(subkey(csrf), sessionToken) — bound to the session, stateless.
 *     It is exposed to the dashboard via a non-HttpOnly cookie and must be echoed back in the
 *     `X-CSRF-Token` header (a cross-site attacker can neither read the cookie nor set the header).
 *  2. When an Origin header is present it must be an allowed origin.
 *  3. Session cookies are SameSite=Lax.
 * Bearer API-key requests are not cookie-authenticated and are therefore not subject to CSRF.
 */
export const CSRF_HEADER = 'x-csrf-token';

export function csrfTokenFor(sessionToken: string): string {
  return hmacSha256(getKeyring().subkey('csrf'), sessionToken).toString('base64url');
}

export function verifyCsrf(req: FastifyRequest, auth: SessionAuth): void {
  const origin = req.headers.origin;
  if (origin && !env().corsOrigins.includes(origin.replace(/\/+$/, ''))) {
    void securityEvent('CSRF_FAILED', { ip: req.clientIp, userId: auth.user.id, details: { reason: 'origin', origin } });
    throw new AppError('csrf_failed');
  }
  const header = req.headers[CSRF_HEADER];
  if (typeof header !== 'string' || !safeEqual(header, csrfTokenFor(auth.token))) {
    void securityEvent('CSRF_FAILED', { ip: req.clientIp, userId: auth.user.id, details: { reason: 'token' } });
    throw new AppError('csrf_failed');
  }
}
