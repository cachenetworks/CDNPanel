import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma } from '@cdn/database';
import { AppError, hashApiKey, isApiScope, looksLikeApiKey, safeEqual, type ApiScope } from '@cdn/shared';
import { getKeyring } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { ipMatchesAny } from '../lib/ip.js';
import { getSettings } from '../lib/settings.js';
import { loadSession, sessionCookieName } from '../lib/sessions.js';
import type { ApiKeyAuth } from './context.js';
import { apiKeyRateLimit } from './rateLimitHook.js';

/**
 * Resolves `request.auth` from either a Bearer API key or the staff session cookie.
 * Route-level enforcement (required auth mode, permission, scope) happens in route.ts.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  req.auth = null;
  const header = req.headers.authorization;
  if (header !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) throw new AppError('invalid_api_key', 'The Authorization header must use the Bearer scheme.');
    req.auth = await authenticateApiKey(req, reply, match[1]!);
    return;
  }
  const token = req.cookies?.[sessionCookieName()];
  if (token) req.auth = await loadSession(token);
}

// API key usage stats are accumulated in memory and flushed periodically (no write per request).
const usage = new Map<string, { count: number; at: Date; ip: string }>();
let usageTimer: NodeJS.Timeout | null = null;

export async function flushApiKeyUsage(): Promise<void> {
  if (usage.size === 0) return;
  const entries = [...usage.entries()];
  usage.clear();
  const prisma = getPrisma();
  await Promise.all(
    entries.map(([id, u]) =>
      prisma.apiKey
        .update({ where: { id }, data: { lastUsedAt: u.at, lastUsedIp: u.ip, requestCount: { increment: u.count } } })
        .catch(() => undefined),
    ),
  );
}

function trackUsage(id: string, ip: string): void {
  const u = usage.get(id) ?? { count: 0, at: new Date(), ip };
  u.count++;
  u.at = new Date();
  u.ip = ip;
  usage.set(id, u);
  if (!usageTimer) {
    usageTimer = setInterval(() => void flushApiKeyUsage(), 5000);
    usageTimer.unref();
  }
}

export function stopApiKeyUsageTimer(): void {
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = null;
}

async function authenticateApiKey(req: FastifyRequest, reply: FastifyReply, presented: string): Promise<ApiKeyAuth> {
  const ua = req.headers['user-agent'] ?? null;
  if (!looksLikeApiKey(presented)) {
    void securityEvent('INVALID_API_KEY', { ip: req.clientIp, userAgent: ua, details: { reason: 'format' } });
    throw new AppError('invalid_api_key');
  }
  const keyring = getKeyring();
  const prisma = getPrisma();
  // Look the key up by its HMAC under each available key version (current first).
  let key = null;
  for (const version of keyring.versions()) {
    const hash = hashApiKey(keyring, presented, version);
    const candidate = await prisma.apiKey.findUnique({ where: { keyHash: hash }, include: { scopes: true, serviceAccount: { select: { enabled: true } } } });
    if (candidate && candidate.hashVersion === version && safeEqual(candidate.keyHash, hash)) {
      key = candidate;
      break;
    }
  }
  if (!key) {
    void securityEvent('INVALID_API_KEY', { ip: req.clientIp, userAgent: ua, details: { reason: 'unknown' } });
    throw new AppError('invalid_api_key');
  }
  if (key.revokedAt) {
    void securityEvent('REVOKED_API_KEY', { ip: req.clientIp, apiKeyId: key.id, userAgent: ua });
    throw new AppError('api_key_revoked');
  }
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    void securityEvent('EXPIRED_API_KEY', { ip: req.clientIp, apiKeyId: key.id, userAgent: ua, severity: 'info' });
    throw new AppError('api_key_expired');
  }
  if (!key.enabled || key.serviceAccount?.enabled === false) throw new AppError('api_key_disabled');
  if (key.suspendedAt) {
    void securityEvent('API_KEY_SUSPENDED', { ip: req.clientIp, apiKeyId: key.id, userAgent: ua, severity: 'info', details: { rejected: true } });
    throw new AppError('api_key_suspended');
  }
  if (key.ipRestrictions.length > 0 && !ipMatchesAny(req.clientIp, key.ipRestrictions)) {
    void securityEvent('API_KEY_IP_BLOCKED', { ip: req.clientIp, apiKeyId: key.id, userAgent: ua });
    throw new AppError('ip_not_allowed');
  }
  const settings = await getSettings();
  await apiKeyRateLimit(req, reply, key.id, key.rateLimit ?? settings.api.defaultKeyRateLimit);
  trackUsage(key.id, req.clientIp);
  return {
    type: 'api_key',
    apiKey: {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      environment: key.environment,
      allowedEndpoints: key.allowedEndpoints,
      projectId: key.projectId,
      serviceAccountId: key.serviceAccountId,
    },
    scopes: new Set(key.scopes.map((s) => s.scope).filter((s): s is ApiScope => isApiScope(s))),
  };
}
