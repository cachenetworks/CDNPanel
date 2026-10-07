import type { Keyring } from './keyring.js';
import { hmacSha256Hex, randomBase62, safeEqual } from './tokens.js';

/**
 * API key format: `cdn_<env>_<32 base62 chars>` (~190 bits of entropy).
 *
 * Storage: only `HMAC-SHA256(subkey(api-key-hash, version), fullKey)` is persisted together
 * with the key version used and a short non-secret display prefix. Because the secret is
 * high-entropy and random, a keyed HMAC is the appropriate construction: it is non-reversible,
 * deterministic (so keys can be looked up by hash via a unique index) and useless to an attacker
 * who only obtains a database dump without the master key. Slow password hashes such as
 * Argon2 are designed for low-entropy secrets and would only add latency to every request.
 */

export type ApiKeyEnvironment = 'live' | 'test';
export const API_KEY_SECRET_LENGTH = 32;
const API_KEY_RE = /^cdn_(live|test)_([0-9A-Za-z]{32})$/;
/** Characters of the secret shown in the non-secret prefix (e.g. `cdn_live_a82f`). */
const PREFIX_SECRET_CHARS = 4;

export interface GeneratedApiKey {
  /** Full key. Return to the caller ONCE and never persist it. */
  key: string;
  prefix: string;
  hash: string;
  hashVersion: number;
  environment: ApiKeyEnvironment;
}

export function generateApiKey(keyring: Keyring, environment: ApiKeyEnvironment = 'live'): GeneratedApiKey {
  const secret = randomBase62(API_KEY_SECRET_LENGTH);
  const key = `cdn_${environment}_${secret}`;
  return {
    key,
    prefix: apiKeyPrefix(key),
    hash: hashApiKey(keyring, key),
    hashVersion: keyring.currentVersion,
    environment,
  };
}

export function parseApiKey(value: string): { environment: ApiKeyEnvironment; secret: string } | null {
  const match = API_KEY_RE.exec(value);
  if (!match) return null;
  return { environment: match[1] as ApiKeyEnvironment, secret: match[2]! };
}

export function looksLikeApiKey(value: string): boolean {
  return API_KEY_RE.test(value);
}

export function apiKeyPrefix(key: string): string {
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error('Invalid API key format');
  return `cdn_${parsed.environment}_${parsed.secret.slice(0, PREFIX_SECRET_CHARS)}`;
}

export function hashApiKey(keyring: Keyring, key: string, version = keyring.currentVersion): string {
  return hmacSha256Hex(keyring.subkey('api-key-hash', version), key);
}

/** Timing-safe verification of a presented key against a stored hash. */
export function verifyApiKey(keyring: Keyring, presented: string, storedHash: string, hashVersion: number): boolean {
  if (!looksLikeApiKey(presented) || !keyring.hasVersion(hashVersion)) return false;
  return safeEqual(hashApiKey(keyring, presented, hashVersion), storedHash);
}

/** Masked representation for display: `cdn_live_ab12••••••••••••••`. */
export function maskApiKeyPrefix(prefix: string): string {
  return `${prefix}${'•'.repeat(14)}`;
}
