import { hmacSha256Hex, safeEqual } from './tokens.js';

/**
 * Webhook signatures (Stripe-style):
 *   X-CDN-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<deliveryId>.<body>")>
 */
export function signWebhookPayload(secret: string, deliveryId: string, timestamp: number, body: string): string {
  const mac = hmacSha256Hex(secret, `${timestamp}.${deliveryId}.${body}`);
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  deliveryId: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string | undefined>;
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${deliveryId}.${body}`), parts.v1);
}
