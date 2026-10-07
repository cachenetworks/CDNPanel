import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { getPrisma } from '@cdn/database';
import { decryptField, signWebhookPayload } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { webhookSecretAad } from '../routes/webhooks.js';

/** Prevents SSRF: webhook targets must resolve to public unicast addresses. */
export async function assertPublicTarget(url: string): Promise<void> {
  if (env().WEBHOOK_ALLOW_PRIVATE_NETWORKS) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) {
    let parsed = ipaddr.parse(a);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    if (parsed.range() !== 'unicast') throw new Error(`Webhook target resolves to a non-public address (${parsed.range()})`);
  }
}

export class PermanentWebhookError extends Error {}

export async function deliverWebhook(deliveryId: string, attempt: number): Promise<void> {
  const prisma = getPrisma();
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { webhook: true } });
  if (!delivery || delivery.status === 'SUCCEEDED') return;
  if (!delivery.webhook.enabled) {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', lastError: 'Webhook disabled' } });
    return;
  }
  const secret = decryptField(getKeyring(), delivery.webhook.secretEnc, webhookSecretAad(delivery.webhookId));
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  let responseCode: number | null = null;
  let responseBody: string | null = null;
  try {
    await assertPublicTarget(delivery.webhook.url);
    const res = await fetch(delivery.webhook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CDN-Webhooks/1.0',
        'X-CDN-Event': delivery.event,
        'X-CDN-Webhook-Id': delivery.id,
        'X-CDN-Webhook-Timestamp': String(timestamp),
        'X-CDN-Signature': signWebhookPayload(secret, delivery.id, timestamp, body),
      },
      body,
    });
    responseCode = res.status;
    responseBody = (await res.text()).slice(0, 1000);
    if (res.status < 200 || res.status >= 300) throw new Error(`Endpoint responded with HTTP ${res.status}`);
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SUCCEEDED', attempts: attempt, responseCode, responseBody, lastError: null, deliveredAt: new Date() },
    });
  } catch (err) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { attempts: attempt, responseCode, responseBody, lastError: (err as Error).message.slice(0, 500) },
    });
    throw err;
  }
}

export async function markWebhookFailed(deliveryId: string): Promise<void> {
  await getPrisma().webhookDelivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: { status: 'FAILED' } });
}
