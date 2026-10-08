import { z } from 'zod';
import { getPrisma, Prisma, type Webhook } from '@cdn/database';
import { AppError, encryptField, isValidId, newId, randomToken } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { env, getKeyring } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { enqueueWebhookDelivery, getQueue, QUEUE_NAMES } from '../lib/queue.js';
import { WEBHOOK_EVENTS } from '../lib/webhooks.js';

const hookParams = z.object({ id: z.string().refine((v) => isValidId('webhook', v), 'invalid webhook id') });
const urlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || (env().NODE_ENV !== 'production' && parsed.protocol === 'http:');
  }, 'webhook URLs must use https');
const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1);

export function webhookSecretAad(id: string): string {
  return `webhook_secret:${id}`;
}

function serializeWebhook(w: Webhook) {
  return {
    id: w.id,
    object: 'webhook' as const,
    name: w.name,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    project_id: w.projectId,
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
  };
}

const HOOK_EXAMPLE = {
  id: 'whk_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'webhook',
  name: 'Indexer',
  url: 'https://hooks.example.com/cdn',
  events: ['file.uploaded', 'file.deleted'],
  enabled: true,
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
};

export const webhookRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/webhooks',
    tag: 'Webhooks',
    summary: 'List webhooks',
    auth: 'session',
    permission: 'settings.view',
    responses: { 200: { description: 'Webhooks', example: { data: [HOOK_EXAMPLE], events: WEBHOOK_EVENTS } } },
    async handler() {
      const hooks = await getPrisma().webhook.findMany({ orderBy: { createdAt: 'asc' } });
      return { data: hooks.map(serializeWebhook), events: WEBHOOK_EVENTS };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks',
    tag: 'Webhooks',
    summary: 'Create a webhook',
    description:
      'Registers an endpoint for events. The signing secret is returned **once**; it is stored encrypted (AES-256-GCM) so the platform can sign deliveries. Each delivery carries `X-CDN-Webhook-Id`, `X-CDN-Webhook-Timestamp`, `X-CDN-Event` and `X-CDN-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<delivery id>.<body>")>`.',
    auth: 'session',
    permission: 'settings.edit',
    body: z.object({ name: z.string().trim().min(1).max(100), url: urlSchema, events: eventsSchema, enabled: z.boolean().default(true), project_id: z.string().nullable().optional() }),
    responses: { 201: { description: 'Created webhook', example: { webhook: HOOK_EXAMPLE, secret: 'whsec_…' } } },
    errors: ['validation_failed'],
    async handler({ req, reply, body, auth }) {
      const id = newId('webhook');
      const secret = `whsec_${randomToken(32)}`;
      const hook = await getPrisma().webhook.create({
        data: {
          id,
          name: body.name,
          url: body.url,
          events: body.events,
          enabled: body.enabled,
          projectId: body.project_id ?? null,
          secretEnc: encryptField(getKeyring(), secret, webhookSecretAad(id)),
          createdById: auth?.type === 'session' ? auth.user.id : null,
        },
      });
      await audit(actorOf(req), 'WEBHOOK_CREATED', { type: 'webhook', id }, { name: body.name, url: body.url, events: body.events });
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return { webhook: serializeWebhook(hook), secret };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/webhooks/:id',
    tag: 'Webhooks',
    summary: 'Update a webhook',
    auth: 'session',
    permission: 'settings.edit',
    params: hookParams,
    body: z
      .object({ name: z.string().trim().min(1).max(100).optional(), url: urlSchema.optional(), events: eventsSchema.optional(), enabled: z.boolean().optional(), project_id: z.string().nullable().optional() })
      .strict(),
    responses: { 200: { description: 'Updated', example: HOOK_EXAMPLE } },
    errors: ['webhook_not_found'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      if (!(await prisma.webhook.findUnique({ where: { id: params.id } }))) throw new AppError('webhook_not_found');
      const { project_id, ...rest } = body;
      const hook = await prisma.webhook.update({ where: { id: params.id }, data: { ...rest, ...(project_id !== undefined ? { projectId: project_id } : {}) } });
      await audit(actorOf(req), 'WEBHOOK_UPDATED', { type: 'webhook', id: hook.id }, { changes: body });
      return serializeWebhook(hook);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks/:id/rotate-secret',
    tag: 'Webhooks',
    summary: 'Rotate a webhook signing secret',
    auth: 'session',
    permission: 'settings.edit',
    params: hookParams,
    responses: { 200: { description: 'New secret (shown once)', example: { secret: 'whsec_…' } } },
    errors: ['webhook_not_found'],
    async handler({ req, reply, params }) {
      const prisma = getPrisma();
      if (!(await prisma.webhook.findUnique({ where: { id: params.id } }))) throw new AppError('webhook_not_found');
      const secret = `whsec_${randomToken(32)}`;
      await prisma.webhook.update({ where: { id: params.id }, data: { secretEnc: encryptField(getKeyring(), secret, webhookSecretAad(params.id)) } });
      await audit(actorOf(req), 'WEBHOOK_UPDATED', { type: 'webhook', id: params.id }, { secret_rotated: true });
      reply.header('Cache-Control', 'no-store');
      return { secret };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/webhooks/:id',
    tag: 'Webhooks',
    summary: 'Delete a webhook',
    auth: 'session',
    permission: 'settings.edit',
    params: hookParams,
    responses: { 204: { description: 'Deleted' } },
    errors: ['webhook_not_found'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const hook = await prisma.webhook.findUnique({ where: { id: params.id } });
      if (!hook) throw new AppError('webhook_not_found');
      await prisma.webhook.delete({ where: { id: hook.id } });
      await audit(actorOf(req), 'WEBHOOK_DELETED', { type: 'webhook', id: hook.id }, { name: hook.name, url: hook.url });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks/:id/test',
    tag: 'Webhooks',
    summary: 'Send a test event',
    description: 'Queues a `webhook.test` delivery to the endpoint.',
    auth: 'session',
    permission: 'settings.edit',
    params: hookParams,
    responses: { 202: { description: 'Queued', example: { delivery_id: 'whd_…' } } },
    errors: ['webhook_not_found'],
    async handler({ reply, params }) {
      const prisma = getPrisma();
      const hook = await prisma.webhook.findUnique({ where: { id: params.id } });
      if (!hook) throw new AppError('webhook_not_found');
      const id = newId('webhookDelivery');
      await prisma.webhookDelivery.create({
        data: { id, webhookId: hook.id, event: 'webhook.test', payload: { id, type: 'webhook.test', created_at: new Date().toISOString(), data: { message: 'This is a test event.' } } },
      });
      await enqueueWebhookDelivery(id);
      reply.code(202);
      return { delivery_id: id };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/webhooks/:id/deliveries',
    tag: 'Webhooks',
    summary: 'List deliveries',
    auth: 'session',
    permission: 'settings.view',
    params: hookParams,
    query: pageQuery,
    responses: { 200: { description: 'Deliveries' } },
    async handler({ params, query }) {
      const prisma = getPrisma();
      const where: Prisma.WebhookDeliveryWhereInput = { webhookId: params.id };
      const [total, rows] = await Promise.all([
        prisma.webhookDelivery.count({ where }),
        prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(
        rows.map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          attempts: d.attempts,
          response_code: d.responseCode,
          last_error: d.lastError,
          delivered_at: d.deliveredAt?.toISOString() ?? null,
          created_at: d.createdAt.toISOString(),
          payload: d.payload,
        })),
        total,
        query.page,
        query.limit,
      );
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/webhooks/deliveries/:id/retry',
    tag: 'Webhooks',
    summary: 'Retry a delivery',
    auth: 'session',
    permission: 'settings.edit',
    params: z.object({ id: z.string().refine((v) => isValidId('webhookDelivery', v), 'invalid delivery id') }),
    responses: { 202: { description: 'Queued' } },
    errors: ['not_found'],
    async handler({ reply, params }) {
      const prisma = getPrisma();
      const d = await prisma.webhookDelivery.findUnique({ where: { id: params.id } });
      if (!d) throw new AppError('not_found');
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', lastError: null } });
      const q = getQueue(QUEUE_NAMES.webhooks);
      const existing = await q.getJob(d.id);
      if (existing) await existing.remove().catch(() => undefined);
      await enqueueWebhookDelivery(d.id);
      reply.code(202);
      return { delivery_id: d.id };
    },
  }),
];
