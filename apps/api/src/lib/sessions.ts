import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma } from '@cdn/database';
import { isPermission, newId, randomToken, sha256Hex, type Permission } from '@cdn/shared';
import { env } from '../config/env.js';
import { getSettings } from './settings.js';
import type { SessionAuth } from '../http/context.js';

/**
 * Staff sessions: a 256-bit random token in an HttpOnly cookie; only its SHA-256 is stored.
 * In production (HTTPS) the cookie uses the `__Host-` prefix, which forces Secure, Path=/ and
 * no Domain attribute so it cannot be set or read by sibling subdomains such as the CDN origin.
 */
export function sessionCookieName(): string {
  return env().cookieSecure ? '__Host-cdn_session' : 'cdn_session';
}

export async function createSession(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  rememberMe: boolean,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const settings = await getSettings();
  const token = randomToken(32);
  const ttlMs = rememberMe ? settings.security.rememberMeDays * 86_400_000 : settings.security.sessionTtlHours * 3_600_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const id = newId('session');
  await getPrisma().session.create({
    data: {
      id,
      userId,
      tokenHash: sha256Hex(token),
      ip: req.clientIp,
      userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
      rememberMe,
      expiresAt,
      // Logging in with the password counts as a fresh re-authentication.
      reauthAt: new Date(),
    },
  });
  reply.setCookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: env().cookieSecure,
    sameSite: 'lax',
    path: '/',
    // Without "remember me" the cookie is a browser-session cookie (server expiry still applies).
    ...(rememberMe ? { expires: expiresAt } : {}),
  });
  return { id, token, expiresAt };
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(), { path: '/', secure: env().cookieSecure, httpOnly: true, sameSite: 'lax' });
}

const lastSeenWrites = new Map<string, number>();

export async function loadSession(token: string): Promise<SessionAuth | null> {
  if (!token || token.length > 128) return null;
  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      user: {
        include: { roles: { include: { role: { include: { permissions: true } } } } },
      },
    },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  const user = session.user;
  if (user.status !== 'ACTIVE') return null;

  const permissions = new Set<Permission>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) if (isPermission(rp.permissionKey)) permissions.add(rp.permissionKey);
  }

  // Throttle lastSeen updates to once a minute per session.
  const last = lastSeenWrites.get(session.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastSeenWrites.set(session.id, Date.now());
    if (lastSeenWrites.size > 10_000) lastSeenWrites.clear();
    void prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }

  return {
    type: 'session',
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      totpEnabled: user.totpEnabled,
      requireTwoFactor: user.requireTwoFactor,
    },
    session: { id: session.id, reauthAt: session.reauthAt, createdAt: session.createdAt },
    permissions,
    roleIds: user.roles.map((r) => r.roleId),
    roleNames: user.roles.map((r) => r.role.name),
  };
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const res = await getPrisma().session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}
