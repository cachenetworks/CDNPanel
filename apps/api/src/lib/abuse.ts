import { getPrisma } from '@cdn/database';
import { audit, onSecurityEvent, securityEvent, type SecurityEventType } from './audit.js';
import { baseLogger } from './logger.js';
import { getRedis } from './redis.js';
import { getSettings } from './settings.js';
import { emitWebhookEvent } from './webhooks.js';

/**
 * Automated response to API-key abuse. Denied / blocked requests made with a key are counted in a
 * sliding window; when the configured threshold is reached the key is suspended (requests are
 * rejected with `api_key_suspended` until an administrator lifts the suspension).
 */

const ABUSE_SIGNALS: ReadonlySet<SecurityEventType> = new Set([
  'API_KEY_IP_BLOCKED',
  'API_KEY_ENDPOINT_BLOCKED',
  'API_KEY_SCOPE_DENIED',
  'API_KEY_PROJECT_DENIED',
  'RATE_LIMITED',
  'EDGE_BLOCKED',
]);

export async function recordKeyAbuse(apiKeyId: string, ip: string | null | undefined, signal: SecurityEventType): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.security.abuseAutoSuspend) return false;
  const redis = getRedis();
  const windowSeconds = settings.security.abuseWindowMinutes * 60;
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `abuse:${apiKeyId}:${bucket}`;
  // Rate limiting is logged at most once a minute, so weight it to stay meaningful.
  const n = await redis.incrby(key, signal === 'RATE_LIMITED' ? 10 : 1);
  if (n <= (signal === 'RATE_LIMITED' ? 10 : 1)) await redis.expire(key, windowSeconds * 2);
  if (n < settings.security.abuseThreshold) return false;
  if (!(await redis.set(`abuse-suspended:${apiKeyId}`, '1', 'EX', 60, 'NX'))) return false;
  const reason = `Automatically suspended: ${n} denied requests within ${settings.security.abuseWindowMinutes} minute(s) (last: ${signal}).`;
  const updated = await getPrisma().apiKey.updateMany({ where: { id: apiKeyId, suspendedAt: null }, data: { suspendedAt: new Date(), suspendedReason: reason } });
  if (updated.count === 0) return false;
  baseLogger.warn({ api_key_id: apiKeyId, count: n }, 'api key suspended for abuse');
  await securityEvent('API_KEY_SUSPENDED', { ip, apiKeyId, severity: 'critical', details: { reason, signal, count: n } });
  await audit({ actorType: 'system', actorLabel: 'abuse-detection' }, 'API_KEY_SUSPENDED', { type: 'api_key', id: apiKeyId }, { reason });
  await emitWebhookEvent('api_key.suspended', { api_key_id: apiKeyId, reason });
  return true;
}

let registered = false;
export function registerAbuseDetection(): void {
  if (registered) return;
  registered = true;
  onSecurityEvent((type, data) => {
    if (data.apiKeyId && ABUSE_SIGNALS.has(type)) {
      void recordKeyAbuse(data.apiKeyId, data.ip, type).catch((err) => baseLogger.error({ err }, 'abuse detection failed'));
    }
  });
}
