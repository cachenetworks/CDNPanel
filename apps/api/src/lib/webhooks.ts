import { getPrisma, Prisma } from '@cdn/database';
import { newId } from '@cdn/shared';
import { enqueueWebhookDelivery } from './queue.js';
import { baseLogger } from './logger.js';

export const WEBHOOK_EVENTS = [
  'file.uploaded',
  'file.updated',
  'file.deleted',
  'upload.failed',
  'api_key.created',
  'api_key.revoked',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Records a delivery row for every enabled webhook subscribed to `event` and queues it.
 * Delivery (signing, HTTP POST, retries) happens in the worker.
 */
export async function emitWebhookEvent(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const prisma = getPrisma();
    const hooks = await prisma.webhook.findMany({ where: { enabled: true, events: { has: event } }, select: { id: true } });
    for (const hook of hooks) {
      const id = newId('webhookDelivery');
      const payload = { id, type: event, created_at: new Date().toISOString(), data };
      await prisma.webhookDelivery.create({
        data: { id, webhookId: hook.id, event, payload: JSON.parse(JSON.stringify(payload, bigintReplacer)) as Prisma.InputJsonValue },
      });
      await enqueueWebhookDelivery(id);
    }
  } catch (err) {
    baseLogger.error({ err, event }, 'failed to emit webhook event');
  }
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}
