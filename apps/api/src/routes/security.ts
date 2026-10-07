import { z } from 'zod';
import { getPrisma, Prisma } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { apiKeyStatus } from '../lib/serialize.js';

export const securityRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/audit-logs',
    tag: 'Audit Logs',
    summary: 'List audit log entries',
    description: 'Append-only audit trail of sensitive actions. Credentials are never recorded.',
    auth: 'session',
    permission: 'logs.view',
    query: pageQuery.extend({
      action: z.string().max(64).optional(),
      actor_id: z.string().max(64).optional(),
      target_type: z.string().max(32).optional(),
      target_id: z.string().max(64).optional(),
      q: z.string().max(200).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
    responses: {
      200: {
        description: 'Audit entries',
        example: {
          data: [{ id: 'aud_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', timestamp: '2026-01-01T10:00:00.000Z', actor_id: 'usr_…', actor_type: 'user', actor_label: 'admin@example.com', action: 'API_KEY_CREATE', target_type: 'api_key', target_id: 'key_…', ip: '203.0.113.10', user_agent: 'Mozilla/5.0', metadata: { name: 'CI' } }],
          pagination: { page: 1, limit: 50, total: 1, total_pages: 1, has_more: false },
        },
      },
    },
    async handler({ query }) {
      const where: Prisma.AuditLogWhereInput = {
        AND: [
          query.action ? { action: query.action } : {},
          query.actor_id ? { actorId: query.actor_id } : {},
          query.target_type ? { targetType: query.target_type } : {},
          query.target_id ? { targetId: query.target_id } : {},
          query.q ? { OR: [{ actorLabel: { contains: query.q, mode: 'insensitive' } }, { targetId: query.q }, { ip: query.q }] } : {},
          query.from ? { timestamp: { gte: query.from } } : {},
          query.to ? { timestamp: { lte: query.to } } : {},
        ],
      };
      const prisma = getPrisma();
      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(
        rows.map((r) => ({
          id: r.id,
          timestamp: r.timestamp.toISOString(),
          actor_id: r.actorId,
          actor_type: r.actorType,
          actor_label: r.actorLabel,
          action: r.action,
          target_type: r.targetType,
          target_id: r.targetId,
          ip: r.ip,
          user_agent: r.userAgent,
          metadata: r.metadata,
        })),
        total,
        query.page,
        query.limit,
      );
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/audit-logs/actions',
    tag: 'Audit Logs',
    summary: 'Distinct audit actions',
    auth: 'session',
    permission: 'logs.view',
    responses: { 200: { description: 'Actions', example: { data: ['LOGIN_SUCCESS', 'FILE_UPLOAD'] } } },
    async handler() {
      const rows = await getPrisma().auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
      return { data: rows.map((r) => r.action) };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/security/events',
    tag: 'Security',
    summary: 'List security events',
    description: 'Failed logins, invalid/expired/revoked API key usage, rate-limit hits, CSRF failures, invalid signed URLs and more.',
    auth: 'session',
    permission: 'logs.view',
    query: pageQuery.extend({ type: z.string().max(64).optional(), ip: z.string().max(64).optional(), severity: z.enum(['info', 'warning', 'critical']).optional() }),
    responses: { 200: { description: 'Security events' } },
    async handler({ query }) {
      const where: Prisma.SecurityEventWhereInput = {
        ...(query.type ? { type: query.type } : {}),
        ...(query.ip ? { ip: query.ip } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
      };
      const prisma = getPrisma();
      const [total, rows] = await Promise.all([
        prisma.securityEvent.count({ where }),
        prisma.securityEvent.findMany({ where, orderBy: { timestamp: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(
        rows.map((r) => ({ id: r.id, timestamp: r.timestamp.toISOString(), type: r.type, severity: r.severity, ip: r.ip, user_id: r.userId, api_key_id: r.apiKeyId, user_agent: r.userAgent, details: r.details })),
        total,
        query.page,
        query.limit,
      );
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/security/summary',
    tag: 'Security',
    summary: 'Security center summary',
    description: 'Counts for the last 24 hours / 7 days, suspicious IPs and API keys, expired and recently revoked keys, active staff sessions and recent login IPs.',
    auth: 'session',
    permission: 'logs.view',
    responses: { 200: { description: 'Summary' } },
    async handler() {
      const prisma = getPrisma();
      const day = new Date(Date.now() - 86_400_000);
      const week = new Date(Date.now() - 7 * 86_400_000);
      const counts = await prisma.securityEvent.groupBy({ by: ['type'], where: { timestamp: { gte: day } }, _count: { _all: true } });
      const suspiciousIps = await prisma.securityEvent.groupBy({
        by: ['ip'],
        where: { timestamp: { gte: week }, ip: { not: null }, type: { in: ['LOGIN_FAILED', 'INVALID_API_KEY', 'RATE_LIMITED', 'CSRF_FAILED', 'SIGNED_URL_INVALID', 'API_KEY_IP_BLOCKED', 'REVOKED_API_KEY'] } },
        _count: { _all: true },
        orderBy: { _count: { ip: 'desc' } },
        take: 10,
      });
      const suspiciousKeys = await prisma.securityEvent.groupBy({
        by: ['apiKeyId'],
        where: { timestamp: { gte: week }, apiKeyId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { apiKeyId: 'desc' } },
        take: 10,
      });
      const keyNames = await prisma.apiKey.findMany({ where: { id: { in: suspiciousKeys.map((k) => k.apiKeyId!) } }, select: { id: true, name: true, prefix: true } });
      const expiredKeys = await prisma.apiKey.findMany({ where: { revokedAt: null, expiresAt: { lte: new Date() } }, orderBy: { expiresAt: 'desc' }, take: 10 });
      const revokedKeys = await prisma.apiKey.findMany({ where: { revokedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { revokedAt: 'desc' }, take: 10 });
      const sessions = await prisma.session.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { lastSeenAt: 'desc' },
        take: 100,
      });
      const recentIps = await prisma.auditLog.groupBy({
        by: ['ip', 'actorLabel'],
        where: { action: 'LOGIN_SUCCESS', timestamp: { gte: new Date(Date.now() - 30 * 86_400_000) }, ip: { not: null } },
        _count: { _all: true },
        _max: { timestamp: true },
        orderBy: { _max: { timestamp: 'desc' } },
        take: 20,
      });
      const byType = Object.fromEntries(counts.map((c) => [c.type, c._count._all]));
      const keyMini = (k: { id: string; name: string; prefix: string; expiresAt: Date | null; revokedAt: Date | null; enabled: boolean; revokedReason: string | null }) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        status: apiKeyStatus(k),
        expires_at: k.expiresAt?.toISOString() ?? null,
        revoked_at: k.revokedAt?.toISOString() ?? null,
        revoked_reason: k.revokedReason,
      });
      return {
        last_24h: {
          failed_logins: byType.LOGIN_FAILED ?? 0,
          account_lockouts: byType.ACCOUNT_LOCKED ?? 0,
          rate_limited: byType.RATE_LIMITED ?? 0,
          invalid_api_keys: (byType.INVALID_API_KEY ?? 0) + (byType.REVOKED_API_KEY ?? 0) + (byType.EXPIRED_API_KEY ?? 0),
          blocked_ips: byType.API_KEY_IP_BLOCKED ?? 0,
          csrf_failures: byType.CSRF_FAILED ?? 0,
          invalid_signed_urls: byType.SIGNED_URL_INVALID ?? 0,
          permission_denied: (byType.PERMISSION_DENIED ?? 0) + (byType.API_KEY_SCOPE_DENIED ?? 0),
        },
        suspicious_ips: suspiciousIps.map((s) => ({ ip: s.ip, events: s._count._all })),
        suspicious_api_keys: suspiciousKeys.map((s) => {
          const k = keyNames.find((n) => n.id === s.apiKeyId);
          return { id: s.apiKeyId, name: k?.name ?? 'deleted', prefix: k?.prefix ?? '', events: s._count._all };
        }),
        expired_api_keys: expiredKeys.map(keyMini),
        revoked_api_keys: revokedKeys.map(keyMini),
        active_sessions: sessions.map((s) => ({
          id: s.id,
          user: s.user,
          ip: s.ip,
          user_agent: s.userAgent,
          last_seen_at: s.lastSeenAt.toISOString(),
          created_at: s.createdAt.toISOString(),
          expires_at: s.expiresAt.toISOString(),
        })),
        recent_login_ips: recentIps.map((r) => ({ ip: r.ip, user: r.actorLabel, logins: r._count._all, last_seen_at: r._max.timestamp?.toISOString() ?? null })),
      };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/security/sessions/:id',
    tag: 'Security',
    summary: 'Revoke a staff session',
    auth: 'session',
    permission: 'users.disable',
    params: z.object({ id: z.string().refine((v) => isValidId('session', v), 'invalid session id') }),
    responses: { 204: { description: 'Revoked' } },
    errors: ['not_found'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const s = await prisma.session.findUnique({ where: { id: params.id }, include: { user: { include: { roles: { include: { role: true } } } } } });
      if (!s || s.revokedAt) throw new AppError('not_found');
      if (s.user.roles.some((r) => r.role.locked) && req.auth?.type === 'session' && !req.auth.roleNames.includes('Founder')) {
        throw new AppError('forbidden', 'Only a Founder can revoke a Founder\'s session.');
      }
      await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
      await audit(actorOf(req), 'SESSION_REVOKED', { type: 'session', id: s.id }, { user_id: s.userId });
    },
  }),
];
