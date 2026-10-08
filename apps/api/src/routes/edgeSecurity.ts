import { z } from 'zod';
import { getPrisma, Prisma, type SecurityRule } from '@cdn/database';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { isValidIpOrCidr } from '../lib/ip.js';
import { getSettings } from '../lib/settings.js';
import { getZones, invalidateZones, zoneBaseUrl } from '../lib/zones.js';
import { requireFolder } from '../lib/folders.js';
import { signAccessCookie, SIGNED_COOKIE } from '../services/delivery.js';
import { banIp, evaluateRules, RULE_FIELDS, RULE_OPS, unbanIp, zoneAccessCheck, type RequestFacts } from '../services/edgeSecurity.js';

const condition = z.object({
  field: z.enum(RULE_FIELDS),
  op: z.enum(RULE_OPS),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(100)).max(500)]),
});

const ruleBody = {
  name: z.string().trim().min(1).max(100),
  zone_id: z.string().nullable().optional(),
  conditions: z.array(condition).min(1).max(10),
  action: z.enum(['ALLOW', 'BLOCK', 'CHALLENGE', 'BAN', 'LOG']),
  ban_minutes: z.number().int().min(1).max(525_600).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
};

function validateConditions(conds: z.infer<typeof condition>[]): void {
  for (const c of conds) {
    if ((c.op === 'in_cidr' || c.op === 'not_in_cidr') && c.field !== 'ip') throw new AppError('validation_failed', 'CIDR operators only apply to the ip field.');
    if (c.op === 'in_cidr' || c.op === 'not_in_cidr') {
      const list = Array.isArray(c.value) ? c.value : String(c.value).split(',').map((v) => v.trim());
      if (!list.every((v) => isValidIpOrCidr(v))) throw new AppError('validation_failed', 'Invalid IP or CIDR in condition.');
    }
    if ((c.op === 'gt' || c.op === 'lt') && !Number.isFinite(Number(c.value))) throw new AppError('validation_failed', `${c.op} requires a number.`);
    if (c.op === 'matches') {
      try {
        new RegExp(String(c.value));
      } catch {
        throw new AppError('validation_failed', 'Invalid regular expression.');
      }
    }
  }
}

export function serializeSecurityRule(r: SecurityRule) {
  return {
    id: r.id,
    object: 'security_rule' as const,
    zone_id: r.zoneId,
    name: r.name,
    conditions: r.conditions,
    action: r.action,
    ban_minutes: r.banMinutes,
    priority: r.priority,
    enabled: r.enabled,
    hits: Number(r.hits),
    last_hit_at: r.lastHitAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

export const edgeSecurityRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/security/rules',
    tag: 'Edge Security',
    summary: 'List security rules',
    auth: 'session',
    permission: 'logs.view',
    query: z.object({ zone_id: z.string().optional() }),
    async handler({ query }) {
      const rows = await getPrisma().securityRule.findMany({ where: query.zone_id ? { zoneId: query.zone_id } : {}, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
      return { data: rows.map(serializeSecurityRule), fields: RULE_FIELDS, operators: RULE_OPS };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/security/rules',
    tag: 'Edge Security',
    summary: 'Create a security rule',
    description:
      'WAF-style rules evaluated on every delivery request (zone rules, then global rules, by priority). All conditions must match. Example — challenge heavy traffic from one country: `[{"field":"country","op":"eq","value":"CN"},{"field":"requests_per_minute","op":"gt","value":500}]` with action `CHALLENGE`. `BAN` blocks the client IP for `ban_minutes`; `LOG` only counts hits.',
    auth: 'session',
    permission: 'security.manage',
    body: z.object(ruleBody),
    responses: { 201: { description: 'Created rule' } },
    errors: ['validation_failed', 'zone_not_found'],
    async handler({ req, reply, body }) {
      validateConditions(body.conditions);
      if (body.zone_id && !(await getPrisma().zone.findUnique({ where: { id: body.zone_id } }))) throw new AppError('zone_not_found');
      const rule = await getPrisma().securityRule.create({
        data: {
          id: newId('securityRule'),
          zoneId: body.zone_id ?? null,
          name: body.name,
          conditions: body.conditions as Prisma.InputJsonValue,
          action: body.action,
          banMinutes: body.action === 'BAN' ? (body.ban_minutes ?? 60) : null,
          priority: body.priority,
          enabled: body.enabled,
        },
      });
      invalidateZones();
      await audit(actorOf(req), 'SECURITY_RULE_CREATE', { type: 'security_rule', id: rule.id }, { name: body.name, action: body.action, conditions: body.conditions });
      reply.code(201);
      return serializeSecurityRule(rule);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/security/rules/:id',
    tag: 'Edge Security',
    summary: 'Update a security rule',
    auth: 'session',
    permission: 'security.manage',
    params: z.object({ id: z.string() }),
    body: z
      .object({
        name: ruleBody.name.optional(),
        conditions: ruleBody.conditions.optional(),
        action: ruleBody.action.optional(),
        ban_minutes: ruleBody.ban_minutes,
        priority: z.number().int().min(0).max(10_000).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    errors: ['rule_not_found', 'validation_failed'],
    async handler({ req, params, body }) {
      const rule = await getPrisma().securityRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      if (body.conditions) validateConditions(body.conditions);
      const updated = await getPrisma().securityRule.update({
        where: { id: rule.id },
        data: {
          name: body.name,
          conditions: body.conditions as Prisma.InputJsonValue | undefined,
          action: body.action,
          banMinutes: body.ban_minutes,
          priority: body.priority,
          enabled: body.enabled,
        },
      });
      invalidateZones();
      await audit(actorOf(req), 'SECURITY_RULE_UPDATE', { type: 'security_rule', id: rule.id }, { changes: body });
      return serializeSecurityRule(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/security/rules/:id',
    tag: 'Edge Security',
    summary: 'Delete a security rule',
    auth: 'session',
    permission: 'security.manage',
    params: z.object({ id: z.string() }),
    errors: ['rule_not_found'],
    async handler({ req, params }) {
      const rule = await getPrisma().securityRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      await getPrisma().securityRule.delete({ where: { id: rule.id } });
      invalidateZones();
      await audit(actorOf(req), 'SECURITY_RULE_DELETE', { type: 'security_rule', id: rule.id }, { name: rule.name });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/security/rules/test',
    tag: 'Edge Security',
    summary: 'Test rules against a sample request',
    description: 'Dry-runs zone restrictions and security rules for a hypothetical request without recording hits.',
    auth: 'session',
    permission: 'logs.view',
    body: z.object({
      zone_id: z.string().nullable().optional(),
      ip: z.string().max(64).default('203.0.113.10'),
      country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
      asn: z.number().int().positive().nullable().optional(),
      path: z.string().max(2000).default('/files/example'),
      method: z.string().max(10).default('GET'),
      host: z.string().max(253).default(''),
      user_agent: z.string().max(500).default('Mozilla/5.0'),
      referer: z.string().max(2000).default(''),
      requests_per_minute: z.number().int().min(0).default(1),
    }),
    async handler({ body }) {
      const reg = await getZones();
      const zone = body.zone_id ? (reg.byId.get(body.zone_id) ?? null) : null;
      const facts: RequestFacts = { ip: body.ip, country: body.country ?? null, asn: body.asn ?? null, path: body.path, method: body.method.toUpperCase(), host: body.host, user_agent: body.user_agent, referer: body.referer, requests_per_minute: body.requests_per_minute };
      const zoneCheck = zoneAccessCheck(zone, facts, new URL(env().APP_URL).hostname);
      if (zoneCheck.outcome === 'block') return { outcome: 'block', reason: zoneCheck.reason, stage: 'zone' };
      const result = await evaluateRules([...(zone?.securityRules ?? []), ...reg.globalRules], facts, { dryRun: true });
      return { outcome: result.outcome, reason: result.reason, stage: result.ruleId ? 'rule' : 'none', rule_id: result.ruleId ?? null, action: result.action ?? null };
    },
  }),

  // ─── IP bans ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/security/bans',
    tag: 'Edge Security',
    summary: 'List IP bans',
    auth: 'session',
    permission: 'logs.view',
    query: z.object({ include_expired: z.enum(['true', 'false']).default('false') }),
    async handler({ query }) {
      const rows = await getPrisma().ipBan.findMany({
        where: query.include_expired === 'true' ? {} : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return { data: rows.map((b) => ({ id: b.id, cidr: b.cidr, reason: b.reason, source: b.source, expires_at: b.expiresAt?.toISOString() ?? null, created_at: b.createdAt.toISOString() })) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/security/bans',
    tag: 'Edge Security',
    summary: 'Ban an IP or network',
    description: 'Blocks every request (dashboard, API and delivery) from an IP or CIDR, permanently or for `minutes`.',
    auth: 'session',
    permission: 'security.manage',
    body: z.object({ cidr: z.string().refine(isValidIpOrCidr, 'invalid IP or CIDR'), reason: z.string().trim().min(1).max(500), minutes: z.number().int().min(1).max(5_256_000).nullable().optional() }),
    responses: { 201: { description: 'Ban created' } },
    errors: ['validation_failed'],
    async handler({ req, reply, body }) {
      if (body.cidr === req.clientIp) throw new AppError('validation_failed', 'You cannot ban your own IP address.');
      const ban = await banIp(body.cidr, body.minutes ?? null, body.reason, 'manual', req.auth?.type === 'session' ? req.auth.user.id : null);
      await audit(actorOf(req), 'IP_BAN_CREATE', { type: 'ip_ban', id: ban.id }, { cidr: body.cidr, minutes: body.minutes, reason: body.reason });
      reply.code(201);
      return { id: ban.id, cidr: ban.cidr, reason: ban.reason, source: ban.source, expires_at: ban.expiresAt?.toISOString() ?? null };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/security/bans/:id',
    tag: 'Edge Security',
    summary: 'Lift an IP ban',
    auth: 'session',
    permission: 'security.manage',
    params: z.object({ id: z.string().refine((v) => isValidId('ipBan', v), 'invalid ban id') }),
    errors: ['not_found'],
    async handler({ req, params }) {
      const ban = await getPrisma().ipBan.findUnique({ where: { id: params.id } });
      if (!ban) throw new AppError('not_found');
      await unbanIp(ban);
      await audit(actorOf(req), 'IP_BAN_DELETE', { type: 'ip_ban', id: ban.id }, { cidr: ban.cidr });
    },
  }),

  // ─── API key suspension (abuse detection) ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/api-keys/:id/unsuspend',
    tag: 'Edge Security',
    summary: 'Lift an automatic API key suspension',
    auth: 'session',
    permission: 'api_keys.revoke',
    params: z.object({ id: z.string().refine((v) => isValidId('apiKey', v), 'invalid key id') }),
    errors: ['api_key_not_found'],
    async handler({ req, params }) {
      const key = await getPrisma().apiKey.findUnique({ where: { id: params.id } });
      if (!key) throw new AppError('api_key_not_found');
      await getPrisma().apiKey.update({ where: { id: key.id }, data: { suspendedAt: null, suspendedReason: null } });
      await audit(actorOf(req), 'API_KEY_UNSUSPENDED', { type: 'api_key', id: key.id }, { previous_reason: key.suspendedReason });
      return { id: key.id, suspended: false };
    },
  }),

  // ─── Signed cookies ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/signed-cookies',
    tag: 'Edge Security',
    summary: 'Issue a signed access cookie',
    description:
      'Grants time-limited access to every private / authenticated file below a folder ("protected collection") without signing each URL. Returns the cookie value and an `install_url` on the CDN host that sets the cookie (HttpOnly, Secure) and redirects — send visitors there once, then plain URLs work.',
    auth: 'any',
    permission: 'files.download',
    scope: 'files:read',
    body: z.object({ folder_id: z.string(), expires_in: z.number().int().min(60).max(30 * 86_400).default(3600), redirect: z.string().max(2000).default('/') }),
    responses: { 200: { description: 'Cookie', example: { cookie_name: 'cdn_access', value: 'v1.…', expires_at: '2026-01-01T00:00:00.000Z', install_url: 'https://cdn.example.com/_auth/cookie?token=…' } } },
    errors: ['folder_not_found'],
    async handler({ req, body }) {
      const folder = await requireFolder(req, body.folder_id);
      const settings = await getSettings();
      const ttl = Math.min(body.expires_in, settings.files.signedUrlMaxExpiry);
      const { value, expires } = signAccessCookie(folder.path, ttl);
      const reg = await getZones();
      const zone = reg.zones.find((z) => z.rootFolder && (folder.path === z.rootFolder.path || folder.path.startsWith(`${z.rootFolder.path}/`))) ?? null;
      const base = zoneBaseUrl(zone, env().CDN_URL);
      await audit(actorOf(req), 'SIGNED_COOKIE_ISSUED', { type: 'folder', id: folder.id }, { path: folder.path, expires_in: ttl });
      return {
        cookie_name: SIGNED_COOKIE,
        value,
        path_prefix: folder.path,
        expires_at: new Date(expires * 1000).toISOString(),
        install_url: `${base}/_auth/cookie?token=${encodeURIComponent(value)}&redirect=${encodeURIComponent(body.redirect)}`,
      };
    },
  }),
];
