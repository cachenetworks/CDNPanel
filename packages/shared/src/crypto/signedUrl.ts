import type { Keyring } from './keyring.js';
import { hmacSha256, safeEqual } from './tokens.js';

/**
 * Expiring signed URLs.
 *
 * signature = base64url(HMAC-SHA256(subkey(signed-url, kv), "v1\n<fileId>\n<expires>\n<disposition>"))
 * Query string: ?expires=<unix seconds>&kv=<key version>&disposition=<inline|attachment>&sig=<signature>
 *
 * The file id, expiry and disposition are all covered by the MAC, so none can be altered.
 */

export interface SignedUrlParams {
  fileId: string;
  expires: number;
  keyVersion: number;
  disposition: 'inline' | 'attachment';
}

function canonical(p: Omit<SignedUrlParams, 'keyVersion'>): string {
  return `v1\n${p.fileId}\n${p.expires}\n${p.disposition}`;
}

export function signFileUrl(
  keyring: Keyring,
  fileId: string,
  expiresInSeconds: number,
  opts: { disposition?: 'inline' | 'attachment'; now?: number } = {},
): { expires: number; query: string; signature: string } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expires = now + Math.floor(expiresInSeconds);
  const disposition = opts.disposition ?? 'inline';
  const keyVersion = keyring.currentVersion;
  const signature = hmacSha256(keyring.subkey('signed-url', keyVersion), canonical({ fileId, expires, disposition })).toString('base64url');
  const qs = new URLSearchParams({ expires: String(expires), kv: String(keyVersion), disposition, sig: signature });
  return { expires, query: qs.toString(), signature };
}

export type SignedUrlVerification = { ok: true; disposition: 'inline' | 'attachment' } | { ok: false; reason: 'invalid_signature' | 'signature_expired' };

export function verifySignedFileUrl(
  keyring: Keyring,
  fileId: string,
  query: Record<string, unknown>,
  now = Math.floor(Date.now() / 1000),
): SignedUrlVerification {
  const expiresRaw = query.expires;
  const sig = query.sig;
  const kvRaw = query.kv;
  const dispositionRaw = query.disposition ?? 'inline';
  if (typeof expiresRaw !== 'string' || typeof sig !== 'string' || typeof kvRaw !== 'string') {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (!/^\d{1,12}$/.test(expiresRaw) || !/^\d{1,6}$/.test(kvRaw) || sig.length > 128) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (dispositionRaw !== 'inline' && dispositionRaw !== 'attachment') return { ok: false, reason: 'invalid_signature' };
  const expires = Number(expiresRaw);
  const kv = Number(kvRaw);
  if (!keyring.hasVersion(kv)) return { ok: false, reason: 'invalid_signature' };
  const expected = hmacSha256(keyring.subkey('signed-url', kv), canonical({ fileId, expires, disposition: dispositionRaw })).toString('base64url');
  // Verify the MAC before revealing whether the link merely expired.
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'invalid_signature' };
  if (expires < now) return { ok: false, reason: 'signature_expired' };
  return { ok: true, disposition: dispositionRaw };
}
