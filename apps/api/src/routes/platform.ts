import { z } from 'zod';
import { getPrisma, Prisma, type ApiKeyTemplate, type ServiceAccount } from '@cdn/database';
import { ALL_SCOPES, AppError, isApiScope, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { isValidIpOrCidr } from '../lib/ip.js';
import { enqueueWebhookDelivery } from '../lib/queue.js';
import { WEBHOOK_EVENTS } from '../lib/webhooks.js';

function serializeServiceAccount(sa: ServiceAccount & { _count?: { apiKeys: number }; project?: { id: string; name: string } | null }) {
  return {
    id: sa.id,
    object: 'service_account' as const,
    name: sa.name,
    description: sa.description,
    project: sa.project ? { id: sa.project.id, name: sa.project.name } : null,
    enabled: sa.enabled,
    api_key_count: sa._count?.apiKeys,
    created_at: sa.createdAt.toISOString(),
    updated_at: sa.updatedAt.toISOString(),
  };
}

function serializeTemplate(t: ApiKeyTemplate) {
  return {
    id: t.id,
    object: 'api_key_template' as const,
    name: t.name,
    description: t.description,
    scopes: t.scopes,
    rate_limit: t.rateLimit,
    ip_restrictions: t.ipRestrictions,
    allowed_endpoints: t.allowedEndpoints,
    expires_in_days: t.expiresInDays,
    environment: t.environment.toLowerCase(),
    created_at: t.createdAt.toISOString(),
  };
}

const templateBody = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  scopes: z.array(z.string()).min(1).max(ALL_SCOPES.length).refine((a) => a.every(isApiScope), 'unknown scope'),
  rate_limit: z.number().int().min(1).max(100_000).nullable().optional(),
  ip_restrictions: z.array(z.string()).max(100).refine((a) => a.every(isValidIpOrCidr), 'invalid IP or CIDR').default([]),
  allowed_endpoints: z.array(z.string().max(200)).max(100).default([]),
  expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
  environment: z.enum(['live', 'test']).default('live'),
};

export const platformRoutes: RouteDef<any, any, any>[] = [
  // ─── Service accounts ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/service-accounts',
    tag: 'Service Accounts',
    summary: 'List service accounts',
    auth: 'session',
    permission: 'api_keys.view',
    async handler() {
      const rows = await getPrisma().serviceAccount.findMany({ include: { _count: { select: { apiKeys: true } }, project: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } });
      return { data: rows.map(serializeServiceAccount) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/service-accounts',
    tag: 'Service Accounts',
    summary: 'Create a service account',
    description: 'A machine identity (CI pipeline, bot, backend service) that owns API keys. Disabling a service account disables all of its keys at once.',
    auth: 'session',
    permission: 'api_keys.create',
    body: z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default(''), project_id: z.string().nullable().optional() }),
    responses: { 201: { description: 'Service account' } },
    errors: ['conflict', 'project_not_found'],
    async handler({ req, reply, body, auth }) {
      const prisma = getPrisma();
      if (body.project_id && !(await prisma.project.findUnique({ where: { id: body.project_id } }))) throw new AppError('project_not_found');
      if (await prisma.serviceAccount.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A service account with that name already exists.');
      const sa = await prisma.serviceAccount.create({
        data: { id: newId('serviceAccount'), name: body.name, description: body.description, projectId: body.project_id ?? null, createdById: auth?.type === 'session' ? auth.user.id : null },
        include: { project: { select: { id: true, name: true } } },
      });
      await audit(actorOf(req), 'SERVICE_ACCOUNT_CREATE', { type: 'service_account', id: sa.id }, { name: body.name, project_id: body.project_id });
      reply.code(201);
      return serializeServiceAccount(sa);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/service-accounts/:id',
    tag: 'Service Accounts',
    summary: 'Update a service account',
    auth: 'session',
    permission: 'api_keys.revoke',
    params: z.object({ id: z.string().refine((v) => isValidId('serviceAccount', v), 'invalid id') }),
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).optional(), enabled: z.boolean().optional(), project_id: z.string().nullable().optional() }).strict(),
    errors: ['not_found'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const sa = await prisma.serviceAccount.findUnique({ where: { id: params.id } });
      if (!sa) throw new AppError('not_found');
      const updated = await prisma.serviceAccount.update({
        where: { id: sa.id },
        data: { name: body.name, description: body.description, enabled: body.enabled, projectId: body.project_id },
        include: { _count: { select: { apiKeys: true } }, project: { select: { id: true, name: true } } },
      });
      // Keys follow the service account's project binding.
      if (body.project_id !== undefined) await prisma.apiKey.updateMany({ where: { serviceAccountId: sa.id }, data: { projectId: body.project_id } });
      await audit(actorOf(req), 'SERVICE_ACCOUNT_UPDATE', { type: 'service_account', id: sa.id }, { changes: body });
      return serializeServiceAccount(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/service-accounts/:id',
    tag: 'Service Accounts',
    summary: 'Delete a service account and its API keys',
    auth: 'session',
    permission: 'api_keys.revoke',
    requireReauth: true,
    params: z.object({ id: z.string().refine((v) => isValidId('serviceAccount', v), 'invalid id') }),
    errors: ['not_found', 'reauthentication_required'],
    async handler({ req, params }) {
      const sa = await getPrisma().serviceAccount.findUnique({ where: { id: params.id }, include: { _count: { select: { apiKeys: true } } } });
      if (!sa) throw new AppError('not_found');
      await getPrisma().serviceAccount.delete({ where: { id: sa.id } });
      await audit(actorOf(req), 'SERVICE_ACCOUNT_DELETE', { type: 'service_account', id: sa.id }, { name: sa.name, api_keys_deleted: sa._count.apiKeys });
    },
  }),

  // ─── API key templates ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/api-key-templates',
    tag: 'Service Accounts',
    summary: 'List API key templates',
    auth: 'session',
    permission: 'api_keys.view',
    async handler() {
      const rows = await getPrisma().apiKeyTemplate.findMany({ orderBy: { name: 'asc' } });
      return { data: rows.map(serializeTemplate) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/api-key-templates',
    tag: 'Service Accounts',
    summary: 'Create an API key template',
    description: 'Reusable presets (scopes, rate limit, IP and endpoint restrictions, lifetime) applied with `template_id` when creating keys.',
    auth: 'session',
    permission: 'api_keys.create',
    body: z.object(templateBody),
    responses: { 201: { description: 'Template' } },
    errors: ['conflict'],
    async handler({ req, reply, body }) {
      if (await getPrisma().apiKeyTemplate.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A template with that name already exists.');
      const t = await getPrisma().apiKeyTemplate.create({
        data: {
          id: newId('apiKeyTemplate'),
          name: body.name,
          description: body.description,
          scopes: [...new Set(body.scopes)],
          rateLimit: body.rate_limit ?? null,
          ipRestrictions: body.ip_restrictions,
          allowedEndpoints: body.allowed_endpoints,
          expiresInDays: body.expires_in_days ?? null,
          environment: body.environment === 'test' ? 'TEST' : 'LIVE',
        },
      });
      await audit(actorOf(req), 'API_KEY_TEMPLATE_CREATE', { type: 'api_key_template', id: t.id }, { name: body.name, scopes: body.scopes });
      reply.code(201);
      return serializeTemplate(t);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/api-key-templates/:id',
    tag: 'Service Accounts',
    summary: 'Delete an API key template',
    auth: 'session',
    permission: 'api_keys.create',
    params: z.object({ id: z.string() }),
    errors: ['not_found'],
    async handler({ req, params }) {
      const t = await getPrisma().apiKeyTemplate.findUnique({ where: { id: params.id } });
      if (!t) throw new AppError('not_found');
      await getPrisma().apiKeyTemplate.delete({ where: { id: t.id } });
      await audit(actorOf(req), 'API_KEY_TEMPLATE_DELETE', { type: 'api_key_template', id: t.id }, { name: t.name });
    },
  }),

  // ─── Webhook replay / testing ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks/deliveries/:id/replay',
    tag: 'Webhooks',
    summary: 'Replay a delivery',
    description: 'Sends the same payload again as a new delivery (new delivery id and signature), keeping the original record intact. Useful after fixing a receiver.',
    auth: 'session',
    permission: 'settings.edit',
    params: z.object({ id: z.string().refine((v) => isValidId('webhookDelivery', v), 'invalid delivery id') }),
    responses: { 202: { description: 'Queued', example: { delivery_id: 'whd_…', replay_of: 'whd_…' } } },
    errors: ['not_found'],
    async handler({ req, reply, params }) {
      const prisma = getPrisma();
      const d = await prisma.webhookDelivery.findUnique({ where: { id: params.id } });
      if (!d) throw new AppError('not_found');
      const id = newId('webhookDelivery');
      const original = (d.payload ?? {}) as Record<string, unknown>;
      const payload = { ...original, id, replay_of: d.id, replayed_at: new Date().toISOString() };
      await prisma.webhookDelivery.create({ data: { id, webhookId: d.webhookId, event: d.event, payload: payload as Prisma.InputJsonValue } });
      await enqueueWebhookDelivery(id);
      await audit(actorOf(req), 'WEBHOOK_REPLAYED', { type: 'webhook', id: d.webhookId }, { delivery_id: d.id, new_delivery_id: id });
      reply.code(202);
      return { delivery_id: id, replay_of: d.id };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks/:id/test-event',
    tag: 'Webhooks',
    summary: 'Send a sample event of a given type',
    description: 'Queues a realistic sample payload for any event type (marked `"test": true`) so receivers can be developed against real shapes.',
    auth: 'session',
    permission: 'settings.edit',
    params: z.object({ id: z.string().refine((v) => isValidId('webhook', v), 'invalid webhook id') }),
    body: z.object({ event: z.enum(WEBHOOK_EVENTS) }),
    responses: { 202: { description: 'Queued' } },
    errors: ['webhook_not_found'],
    async handler({ reply, params, body }) {
      const prisma = getPrisma();
      const hook = await prisma.webhook.findUnique({ where: { id: params.id } });
      if (!hook) throw new AppError('webhook_not_found');
      const id = newId('webhookDelivery');
      const sampleFile = { id: 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'example.png', folder_id: null, mime_type: 'image/png', size: 1024 };
      const samples: Record<string, Record<string, unknown>> = {
        'file.uploaded': { file: sampleFile },
        'file.updated': { file: sampleFile },
        'file.deleted': { file: sampleFile },
        'file.trashed': { file: sampleFile },
        'file.restored': { file: sampleFile },
        'file.expired': { file: sampleFile },
        'file.version_created': { file: { ...sampleFile, version: 2 }, previous_version: 1 },
        'upload.failed': { filename: 'example.png', error: { code: 'unsupported_file_type' } },
        'api_key.created': { api_key: { id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', prefix: 'cdn_live_a82f' } },
        'api_key.revoked': { api_key: { id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', prefix: 'cdn_live_a82f', reason: 'manual' } },
        'api_key.suspended': { api_key_id: 'key_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', reason: 'Automatically suspended: 100 denied requests within 5 minute(s).' },
        'cache.purged': { purge_id: 'pur_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', type: 'file', targets: [sampleFile.id], status: 'completed' },
        'domain.verified': { domain_id: 'dom_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', hostname: 'assets.example.com' },
        'domain.unhealthy': { domain_id: 'dom_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', hostname: 'assets.example.com', error: 'HTTP 502' },
        'media.ready': { file_id: sampleFile.id, renditions: ['thumbnail', 'hls'] },
        'replication.failed': { file_id: sampleFile.id, provider_id: 'stp_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', error: 'timeout' },
        'share.created': { share_id: 'shr_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', file_id: sampleFile.id, expires_at: null },
        'share.downloaded': { share_id: 'shr_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', file_id: sampleFile.id, country: 'AU' },
        'quota.threshold': { quota_id: 'quo_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', scope_type: 'project', metric: 'egress_bytes', limit: 100 * 1024 ** 3, used: 84 * 1024 ** 3, percent: 84, threshold: 75, hard: false },
      };
      await prisma.webhookDelivery.create({
        data: { id, webhookId: hook.id, event: body.event, payload: { id, type: body.event, test: true, created_at: new Date().toISOString(), data: samples[body.event] ?? {} } as Prisma.InputJsonValue },
      });
      await enqueueWebhookDelivery(id);
      reply.code(202);
      return { delivery_id: id };
    },
  }),
];
