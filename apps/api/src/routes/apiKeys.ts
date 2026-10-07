import { z } from 'zod';
import { getPrisma, Prisma } from '@cdn/database';
import { ALL_SCOPES, AppError, decryptField, encryptField, generateApiKey, isApiScope, isValidId, newId } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { getKeyring } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { isValidIpOrCidr } from '../lib/ip.js';
import { serializeApiKey } from '../lib/serialize.js';
import { getSettings } from '../lib/settings.js';
import { emitWebhookEvent } from '../lib/webhooks.js';

const keyParams = z.object({ id: z.string().refine((v) => isValidId('apiKey', v), 'invalid API key id') });
const scopesSchema = z
  .array(z.string())
  .min(1, 'select at least one scope')
  .max(ALL_SCOPES.length)
  .refine((arr) => arr.every(isApiScope), { message: `scopes must be from: ${ALL_SCOPES.join(', ')}` });
const ipList = z
  .array(z.string().trim())
  .max(100)
  .refine((arr) => arr.every(isValidIpOrCidr), 'each entry must be a valid IP address or CIDR range');
const endpointList = z
  .array(z.string().trim().regex(/^(\*|GET|POST|PATCH|PUT|DELETE|HEAD)\s+\/[\w\-/*.:{}]*$/i, 'use the form "METHOD /path" with optional * wildcards'))
  .max(100);

const INCLUDE = { scopes: true, createdBy: { select: { id: true, name: true, email: true } } } as const;

const KEY_EXAMPLE = {
  id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'api_key',
  name: 'CI uploader',
  prefix: 'cdn_live_a82f',
  masked_key: 'cdn_live_a82f••••••••••••••',
  environment: 'live',
  status: 'active',
  enabled: true,
  scopes: ['files:read', 'files:upload'],
  rate_limit: 600,
  ip_restrictions: ['203.0.113.0/24'],
  allowed_endpoints: [],
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  last_used_at: '2026-01-01T12:00:00.000Z',
  last_used_ip: '203.0.113.10',
  request_count: 1532,
  rotated_from_id: null,
  created_by: { id: 'usr_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'Ada Admin', email: 'admin@example.com' },
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
};

async function resolveExpiry(expiresAt: Date | null | undefined): Promise<Date | null> {
  const settings = await getSettings();
  const max = settings.api.maxKeyLifetimeDays;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('validation_failed', 'expires_at must be in the future.');
  if (max) {
    const limit = new Date(Date.now() + max * 86_400_000);
    if (!expiresAt) return limit;
    if (expiresAt > limit) throw new AppError('validation_failed', `API keys may not live longer than ${max} days.`);
  }
  return expiresAt ?? null;
}

export const apiKeyRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/api-keys',
    tag: 'API Keys',
    summary: 'List API keys',
    description: 'Lists API keys. The secret part of a key is never returned — only its non-secret prefix.',
    auth: 'session',
    permission: 'api_keys.view',
    query: pageQuery.extend({ status: z.enum(['active', 'disabled', 'revoked', 'expired']).optional(), q: z.string().max(100).optional() }),
    responses: { 200: { description: 'API keys', example: { data: [KEY_EXAMPLE], pagination: { page: 1, limit: 50, total: 1, total_pages: 1, has_more: false } } } },
    errors: ['staff_session_required', 'forbidden'],
    async handler({ query }) {
      const now = new Date();
      const statusWhere: Record<string, Prisma.ApiKeyWhereInput> = {
        active: { revokedAt: null, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        disabled: { revokedAt: null, enabled: false },
        revoked: { revokedAt: { not: null } },
        expired: { revokedAt: null, expiresAt: { lte: now } },
      };
      const where: Prisma.ApiKeyWhereInput = {
        AND: [
          query.status ? statusWhere[query.status]! : {},
          query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { prefix: { startsWith: query.q } }] } : {},
        ],
      };
      const prisma = getPrisma();
      const [total, rows] = await Promise.all([
        prisma.apiKey.count({ where }),
        prisma.apiKey.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(rows.map(serializeApiKey), total, query.page, query.limit);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/api-keys',
    tag: 'API Keys',
    summary: 'Create an API key',
    description:
      'Creates an API key and returns the full secret **once** in the `key` field. Only a keyed hash (HMAC-SHA256) of the key is stored, so it cannot be retrieved again. Store it in a secrets manager immediately.',
    auth: 'session',
    permission: 'api_keys.create',
    body: z.object({
      name: z.string().trim().min(1).max(100),
      environment: z.enum(['live', 'test']).default('live'),
      scopes: scopesSchema,
      expires_at: z.coerce.date().nullable().optional(),
      rate_limit: z.number().int().min(1).max(100000).nullable().optional(),
      ip_restrictions: ipList.default([]),
      allowed_endpoints: endpointList.default([]),
      notes: z.string().max(2000).optional(),
    }),
    responses: { 201: { description: 'Created key (secret shown once)', example: { api_key: KEY_EXAMPLE, key: 'cdn_live_a82fQ0m3x9Lr2Ty7Vb4Nc8Hs1Kd6Pz5Wq' } } },
    errors: ['validation_failed', 'forbidden'],
    async handler({ req, reply, body, auth }) {
      const s = auth as SessionAuth;
      const generated = generateApiKey(getKeyring(), body.environment);
      const id = newId('apiKey');
      const key = await getPrisma().apiKey.create({
        data: {
          id,
          name: body.name,
          prefix: generated.prefix,
          keyHash: generated.hash,
          hashVersion: generated.hashVersion,
          environment: body.environment === 'test' ? 'TEST' : 'LIVE',
          createdById: s.user.id,
          expiresAt: await resolveExpiry(body.expires_at),
          rateLimit: body.rate_limit ?? null,
          ipRestrictions: body.ip_restrictions,
          allowedEndpoints: body.allowed_endpoints,
          notesEnc: body.notes ? encryptField(getKeyring(), body.notes, `api_key_notes:${id}`) : null,
          scopes: { create: [...new Set(body.scopes)].map((scope) => ({ scope })) },
        },
        include: INCLUDE,
      });
      await audit(actorOf(req), 'API_KEY_CREATE', { type: 'api_key', id }, { name: body.name, prefix: generated.prefix, scopes: body.scopes, environment: body.environment });
      const serialized = serializeApiKey(key);
      await emitWebhookEvent('api_key.created', { api_key: serialized });
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return { api_key: serialized, key: generated.key };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/api-keys/:id',
    tag: 'API Keys',
    summary: 'Get an API key',
    auth: 'session',
    permission: 'api_keys.view',
    params: keyParams,
    responses: { 200: { description: 'API key', example: { ...KEY_EXAMPLE, notes: 'Used by the release pipeline' } } },
    errors: ['api_key_not_found'],
    async handler({ params }) {
      const key = await getPrisma().apiKey.findUnique({ where: { id: params.id }, include: INCLUDE });
      if (!key) throw new AppError('api_key_not_found');
      let notes: string | null = null;
      if (key.notesEnc) {
        try {
          notes = decryptField(getKeyring(), key.notesEnc, `api_key_notes:${key.id}`);
        } catch {
          notes = null;
        }
      }
      return { ...serializeApiKey(key), notes };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/api-keys/:id',
    tag: 'API Keys',
    summary: 'Update an API key',
    description: 'Changes name, scopes, restrictions, rate limit or expiry. Enabling/disabling requires `api_keys.revoke`. Revoked keys cannot be modified.',
    auth: 'session',
    permission: 'api_keys.create',
    params: keyParams,
    body: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        scopes: scopesSchema.optional(),
        expires_at: z.coerce.date().nullable().optional(),
        rate_limit: z.number().int().min(1).max(100000).nullable().optional(),
        ip_restrictions: ipList.optional(),
        allowed_endpoints: endpointList.optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .strict(),
    responses: { 200: { description: 'Updated key', example: KEY_EXAMPLE } },
    errors: ['api_key_not_found', 'conflict', 'forbidden'],
    async handler({ req, params, body, auth }) {
      const s = auth as SessionAuth;
      const prisma = getPrisma();
      const key = await prisma.apiKey.findUnique({ where: { id: params.id } });
      if (!key) throw new AppError('api_key_not_found');
      if (key.revokedAt) throw new AppError('conflict', 'Revoked keys cannot be modified.');
      if (body.enabled !== undefined && !s.permissions.has('api_keys.revoke')) throw new AppError('forbidden', 'Enabling or disabling keys requires api_keys.revoke.');
      const data: Prisma.ApiKeyUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.enabled !== undefined) data.enabled = body.enabled;
      if (body.expires_at !== undefined) data.expiresAt = await resolveExpiry(body.expires_at);
      if (body.rate_limit !== undefined) data.rateLimit = body.rate_limit;
      if (body.ip_restrictions !== undefined) data.ipRestrictions = body.ip_restrictions;
      if (body.allowed_endpoints !== undefined) data.allowedEndpoints = body.allowed_endpoints;
      if (body.notes !== undefined) data.notesEnc = body.notes ? encryptField(getKeyring(), body.notes, `api_key_notes:${key.id}`) : null;
      const updated = await prisma.$transaction(async (tx) => {
        if (body.scopes) {
          await tx.apiKeyScope.deleteMany({ where: { apiKeyId: key.id } });
          await tx.apiKeyScope.createMany({ data: [...new Set(body.scopes as string[])].map((scope) => ({ apiKeyId: key.id, scope })) });
        }
        return tx.apiKey.update({ where: { id: key.id }, data, include: INCLUDE });
      });
      await audit(actorOf(req), 'API_KEY_UPDATE', { type: 'api_key', id: key.id }, { changes: { ...body, notes: body.notes !== undefined ? '[updated]' : undefined } });
      return serializeApiKey(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/api-keys/:id',
    tag: 'API Keys',
    summary: 'Revoke an API key',
    description: 'Permanently revokes the key. Requests using it fail immediately with `api_key_revoked`.',
    auth: 'session',
    permission: 'api_keys.revoke',
    params: keyParams,
    query: z.object({ reason: z.string().max(200).optional() }),
    responses: { 200: { description: 'Revoked key', example: { ...KEY_EXAMPLE, status: 'revoked', revoked_at: '2026-01-02T10:00:00.000Z' } } },
    errors: ['api_key_not_found'],
    async handler({ req, params, query }) {
      const prisma = getPrisma();
      const key = await prisma.apiKey.findUnique({ where: { id: params.id } });
      if (!key) throw new AppError('api_key_not_found');
      const updated = key.revokedAt
        ? await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id }, include: INCLUDE })
        : await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date(), revokedReason: query.reason ?? null, enabled: false }, include: INCLUDE });
      if (!key.revokedAt) {
        await audit(actorOf(req), 'API_KEY_REVOKE', { type: 'api_key', id: key.id }, { prefix: key.prefix, reason: query.reason });
        await emitWebhookEvent('api_key.revoked', { api_key: serializeApiKey(updated) });
      }
      return serializeApiKey(updated);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/api-keys/:id/rotate',
    tag: 'API Keys',
    summary: 'Rotate an API key',
    description:
      'Issues a new key with identical settings and returns its secret once. The old key is revoked immediately, or after an optional grace period (`grace_period_seconds`, max 7 days) so clients can switch over.',
    auth: 'session',
    permission: 'api_keys.rotate',
    params: keyParams,
    body: z.object({ grace_period_seconds: z.number().int().min(0).max(7 * 86400).default(0) }),
    responses: { 201: { description: 'New key (secret shown once)', example: { api_key: { ...KEY_EXAMPLE, rotated_from_id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P5' }, key: 'cdn_live_b91c…', previous_key_expires_at: null } } },
    errors: ['api_key_not_found', 'conflict'],
    async handler({ req, reply, params, body, auth }) {
      const s = auth as SessionAuth;
      const prisma = getPrisma();
      const old = await prisma.apiKey.findUnique({ where: { id: params.id }, include: { scopes: true } });
      if (!old) throw new AppError('api_key_not_found');
      if (old.revokedAt) throw new AppError('conflict', 'Revoked keys cannot be rotated.');
      const env = old.environment === 'TEST' ? 'test' : 'live';
      const generated = generateApiKey(getKeyring(), env);
      const id = newId('apiKey');
      const graceUntil = body.grace_period_seconds > 0 ? new Date(Date.now() + body.grace_period_seconds * 1000) : null;
      const created = await prisma.$transaction(async (tx) => {
        const k = await tx.apiKey.create({
          data: {
            id,
            name: old.name,
            prefix: generated.prefix,
            keyHash: generated.hash,
            hashVersion: generated.hashVersion,
            environment: old.environment,
            createdById: s.user.id,
            expiresAt: old.expiresAt,
            rateLimit: old.rateLimit,
            ipRestrictions: old.ipRestrictions,
            allowedEndpoints: old.allowedEndpoints,
            notesEnc: null,
            enabled: old.enabled,
            rotatedFromId: old.id,
            scopes: { create: old.scopes.map((sc) => ({ scope: sc.scope })) },
          },
          include: INCLUDE,
        });
        if (graceUntil) {
          await tx.apiKey.update({ where: { id: old.id }, data: { expiresAt: old.expiresAt && old.expiresAt < graceUntil ? old.expiresAt : graceUntil } });
        } else {
          await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date(), revokedReason: 'rotated', enabled: false } });
        }
        return k;
      });
      await audit(actorOf(req), 'API_KEY_ROTATE', { type: 'api_key', id: old.id }, { new_key_id: id, new_prefix: generated.prefix, grace_period_seconds: body.grace_period_seconds });
      if (!graceUntil) await emitWebhookEvent('api_key.revoked', { api_key: { id: old.id, prefix: old.prefix, reason: 'rotated' } });
      await emitWebhookEvent('api_key.created', { api_key: serializeApiKey(created) });
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return { api_key: serializeApiKey(created), key: generated.key, previous_key_expires_at: graceUntil?.toISOString() ?? null };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/api-keys/revoke-all',
    tag: 'API Keys',
    summary: 'Revoke all API keys',
    description: 'Emergency action: revokes every active API key. Requires a recent password re-authentication.',
    auth: 'session',
    permission: 'api_keys.revoke',
    requireReauth: true,
    body: z.object({ confirm: z.literal('REVOKE ALL'), reason: z.string().max(200).optional() }),
    responses: { 200: { description: 'Number of revoked keys', example: { revoked: 7 } } },
    errors: ['reauthentication_required', 'validation_failed'],
    async handler({ req, body }) {
      const res = await getPrisma().apiKey.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date(), revokedReason: body.reason ?? 'revoke_all', enabled: false } });
      await audit(actorOf(req), 'API_KEY_REVOKE_ALL', { type: 'api_key' }, { revoked: res.count, reason: body.reason });
      return { revoked: res.count };
    },
  }),
];
