import { getPrisma, Prisma } from '@cdn/database';
import { newId } from '@cdn/shared';
import { baseLogger } from './logger.js';

export type AuditAction =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'SESSION_REVOKED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_ISSUED'
  | 'TWO_FACTOR_ENABLED'
  | 'TWO_FACTOR_DISABLED'
  | 'RECOVERY_CODES_REGENERATED'
  | 'FILE_UPLOAD'
  | 'FILE_DELETE'
  | 'FILE_BULK_DELETE'
  | 'FILE_MOVE'
  | 'FILE_COPY'
  | 'FILE_RENAME'
  | 'FILE_UPDATE'
  | 'FILE_QUARANTINED'
  | 'SIGNED_URL_CREATED'
  | 'FOLDER_CREATE'
  | 'FOLDER_UPDATE'
  | 'FOLDER_MOVE'
  | 'FOLDER_DELETE'
  | 'API_KEY_CREATE'
  | 'API_KEY_UPDATE'
  | 'API_KEY_ROTATE'
  | 'API_KEY_REVOKE'
  | 'API_KEY_REVOKE_ALL'
  | 'USER_CREATE'
  | 'USER_INVITE'
  | 'USER_UPDATE'
  | 'USER_DISABLE'
  | 'USER_ENABLE'
  | 'USER_DELETE'
  | 'INVITE_ACCEPTED'
  | 'ROLE_CREATED'
  | 'ROLE_UPDATED'
  | 'ROLE_DELETED'
  | 'SETTINGS_UPDATED'
  | 'SETTINGS_RESET'
  | 'STORAGE_PROVIDER_CREATED'
  | 'STORAGE_PROVIDER_UPDATED'
  | 'STORAGE_PROVIDER_DELETED'
  | 'WEBHOOK_CREATED'
  | 'WEBHOOK_UPDATED'
  | 'WEBHOOK_DELETED';

export interface AuditContext {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system';
  actorLabel?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

const SENSITIVE_KEY = /pass(word)?|token|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|totp|recovery/i;

/** Deep-copies metadata, removing anything that looks like a credential. */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/^cdn_(live|test)_[0-9A-Za-z]{32}$/.test(value)) return '[REDACTED]';
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeMetadata(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function audit(
  ctx: AuditContext,
  action: AuditAction,
  target?: { type: string; id?: string | null } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await getPrisma().auditLog.create({
      data: {
        id: newId('auditLog'),
        actorId: ctx.actorType === 'api_key' ? null : (ctx.actorId ?? null),
        actorType: ctx.actorType ?? (ctx.actorId ? 'user' : 'system'),
        actorLabel: ctx.actorLabel ?? null,
        action,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        metadata: sanitizeMetadata({ ...metadata, ...(ctx.actorType === 'api_key' ? { api_key_id: ctx.actorId } : {}) }) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Audit failures must be visible but must not leak details to clients.
    baseLogger.error({ err, action }, 'failed to write audit log');
  }
}

export type SecurityEventType =
  | 'LOGIN_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'RATE_LIMITED'
  | 'INVALID_API_KEY'
  | 'EXPIRED_API_KEY'
  | 'REVOKED_API_KEY'
  | 'API_KEY_IP_BLOCKED'
  | 'API_KEY_ENDPOINT_BLOCKED'
  | 'API_KEY_SCOPE_DENIED'
  | 'CSRF_FAILED'
  | 'SIGNED_URL_INVALID'
  | 'MFA_FAILED'
  | 'PERMISSION_DENIED'
  | 'MALWARE_DETECTED';

export async function securityEvent(
  type: SecurityEventType,
  data: { ip?: string | null; userId?: string | null; apiKeyId?: string | null; userAgent?: string | null; severity?: 'info' | 'warning' | 'critical'; details?: Record<string, unknown> },
): Promise<void> {
  try {
    await getPrisma().securityEvent.create({
      data: {
        id: newId('securityEvent'),
        type,
        severity: data.severity ?? 'warning',
        ip: data.ip ?? null,
        userId: data.userId ?? null,
        apiKeyId: data.apiKeyId ?? null,
        userAgent: data.userAgent?.slice(0, 512) ?? null,
        details: sanitizeMetadata(data.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    baseLogger.error({ err, type }, 'failed to write security event');
  }
}
