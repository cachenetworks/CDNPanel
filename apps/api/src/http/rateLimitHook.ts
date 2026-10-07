import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@cdn/shared';
import { RateLimiter, type RateLimitResult } from '../lib/rateLimit.js';
import { getRedis } from '../lib/redis.js';
import { getSettings } from '../lib/settings.js';
import { securityEvent } from '../lib/audit.js';

let limiter: RateLimiter | undefined;

export function getRateLimiter(): RateLimiter {
  if (!limiter) limiter = new RateLimiter(getRedis());
  return limiter;
}

export function applyRateLimitHeaders(reply: FastifyReply, rl: RateLimitResult): void {
  // When several limits apply, report the most restrictive one.
  const prev = Number(reply.getHeader('x-ratelimit-remaining'));
  if (Number.isFinite(prev) && reply.hasHeader('x-ratelimit-remaining') && prev < rl.remaining) return;
  reply.header('X-RateLimit-Limit', String(rl.limit));
  reply.header('X-RateLimit-Remaining', String(rl.remaining));
  reply.header('X-RateLimit-Reset', String(rl.reset));
}

import { isDeliveryPath } from './paths.js';

/** Global + per-IP limits applied to every request. */
export async function globalRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.url.startsWith('/health')) return;
  const settings = await getSettings();
  const rl = getRateLimiter();
  const delivery = isDeliveryPath(req.url);
  const [global, perIp] = await Promise.all([
    rl.hit('global', settings.rateLimits.globalPerMinute, 60),
    rl.hit(`${delivery ? 'dip' : 'ip'}:${req.clientIp}`, delivery ? settings.rateLimits.deliveryPerIpPerMinute : settings.rateLimits.perIpPerMinute, 60),
  ]);
  applyRateLimitHeaders(reply, global);
  applyRateLimitHeaders(reply, perIp);
  const blocked = !global.allowed ? global : !perIp.allowed ? perIp : null;
  if (blocked) {
    reply.header('Retry-After', String(blocked.retryAfter));
    await logRateLimitOnce(req.clientIp, blocked === global ? 'global' : 'ip', req.url.split('?')[0]!);
    throw new AppError('rate_limited');
  }
}

/** Records at most one RATE_LIMITED security event per IP+bucket per minute, so floods do not flood the DB. */
export async function logRateLimitOnce(ip: string, bucket: string, path: string, apiKeyId?: string): Promise<void> {
  const fresh = await getRedis().set(`rlev:${bucket}:${apiKeyId ?? ip}`, '1', 'EX', 60, 'NX');
  if (fresh) void securityEvent('RATE_LIMITED', { ip, apiKeyId, severity: 'info', details: { bucket, path } });
}

/** Per-API-key limit (requests per minute). */
export async function apiKeyRateLimit(req: FastifyRequest, reply: FastifyReply, apiKeyId: string, perMinute: number): Promise<void> {
  const rl = await getRateLimiter().hit(`key:${apiKeyId}`, perMinute, 60);
  applyRateLimitHeaders(reply, rl);
  if (!rl.allowed) {
    reply.header('Retry-After', String(rl.retryAfter));
    await logRateLimitOnce(req.clientIp, 'api_key', req.url.split('?')[0]!, apiKeyId);
    throw new AppError('rate_limited');
  }
}
