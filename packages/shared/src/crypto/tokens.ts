import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(key: Buffer | string, input: string | Buffer): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

export function hmacSha256Hex(key: Buffer | string, input: string | Buffer): string {
  return hmacSha256(key, input).toString('hex');
}

/** Constant-time comparison of two strings; returns false for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn comparable time to avoid leaking length via early exit.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniformly random base62 string using rejection sampling (no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (const byte of buf) {
      if (byte < 248) {
        out += BASE62[byte % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}
