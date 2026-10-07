import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Keyring,
  apiKeyPrefix,
  decryptField,
  encryptField,
  generateApiKey,
  hashApiKey,
  needsReencryption,
  parseApiKey,
  signFileUrl,
  signWebhookPayload,
  verifyApiKey,
  verifySignedFileUrl,
  verifyWebhookSignature,
} from './index.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const keyring = new Keyring({ version: 1, key: k1 });

describe('Keyring', () => {
  it('rejects keys that are not 32 bytes', () => {
    expect(() => new Keyring({ version: 1, key: randomBytes(16) })).toThrow(/32 bytes/);
  });
  it('derives distinct subkeys per purpose', () => {
    expect(keyring.subkey('api-key-hash').equals(keyring.subkey('signed-url'))).toBe(false);
  });
  it('parses previous keys from env format', () => {
    const kr = Keyring.fromEnv(k2.toString('base64'), 2, `1:${k1.toString('base64')}`);
    expect(kr.versions()).toEqual([2, 1]);
  });
});

describe('AES-256-GCM field encryption', () => {
  it('round-trips and stores version, iv, tag, ciphertext', () => {
    const enc = encryptField(keyring, 's3cr3t-credential', 'ctx:1');
    expect(enc.split('.')).toHaveLength(6);
    expect(enc).not.toContain('s3cr3t');
    expect(decryptField(keyring, enc, 'ctx:1')).toBe('s3cr3t-credential');
  });
  it('uses a fresh IV for every encryption', () => {
    expect(encryptField(keyring, 'x')).not.toBe(encryptField(keyring, 'x'));
  });
  it('fails authentication when the ciphertext is tampered with', () => {
    const parts = encryptField(keyring, 'hello').split('.');
    const ct = Buffer.from(parts[5]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[5] = ct.toString('base64url');
    expect(() => decryptField(keyring, parts.join('.'))).toThrow();
  });
  it('fails when the AAD differs (row swapping)', () => {
    const enc = encryptField(keyring, 'hello', 'provider:a');
    expect(() => decryptField(keyring, enc, 'provider:b')).toThrow();
  });
  it('supports key rotation', () => {
    const old = encryptField(keyring, 'legacy');
    const rotated = new Keyring({ version: 2, key: k2 }, [{ version: 1, key: k1 }]);
    expect(decryptField(rotated, old)).toBe('legacy');
    expect(needsReencryption(rotated, old)).toBe(true);
    expect(needsReencryption(rotated, encryptField(rotated, 'new'))).toBe(false);
  });
});

describe('API keys', () => {
  it('generates keys in the documented format', () => {
    const g = generateApiKey(keyring, 'live');
    expect(g.key).toMatch(/^cdn_live_[0-9A-Za-z]{32}$/);
    expect(g.prefix).toBe(g.key.slice(0, 13));
    expect(apiKeyPrefix(g.key)).toBe(g.prefix);
    expect(generateApiKey(keyring, 'test').key.startsWith('cdn_test_')).toBe(true);
  });
  it('never exposes the raw key in its hash', () => {
    const g = generateApiKey(keyring);
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(g.hash).not.toContain(g.key.slice(9));
  });
  it('verifies correct keys and rejects others', () => {
    const g = generateApiKey(keyring);
    expect(verifyApiKey(keyring, g.key, g.hash, g.hashVersion)).toBe(true);
    const other = generateApiKey(keyring);
    expect(verifyApiKey(keyring, other.key, g.hash, g.hashVersion)).toBe(false);
    expect(verifyApiKey(keyring, 'not-a-key', g.hash, g.hashVersion)).toBe(false);
    expect(verifyApiKey(keyring, g.key, g.hash, 99)).toBe(false);
  });
  it('hashes depend on the master key', () => {
    const g = generateApiKey(keyring);
    expect(hashApiKey(new Keyring({ version: 1, key: k2 }), g.key)).not.toBe(g.hash);
  });
  it('parses only well-formed keys', () => {
    expect(parseApiKey('cdn_live_short')).toBeNull();
    expect(parseApiKey('cdn_prod_' + 'a'.repeat(32))).toBeNull();
    expect(parseApiKey('cdn_live_' + 'a'.repeat(32))).toEqual({ environment: 'live', secret: 'a'.repeat(32) });
  });
  it('produces unique keys', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateApiKey(keyring).key));
    expect(set.size).toBe(200);
  });
});

describe('signed URLs', () => {
  const fileId = 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6';
  const q = (query: string) => Object.fromEntries(new URLSearchParams(query));

  it('accepts a valid signature', () => {
    const s = signFileUrl(keyring, fileId, 300);
    expect(verifySignedFileUrl(keyring, fileId, q(s.query))).toEqual({ ok: true, disposition: 'inline' });
  });
  it('rejects expired signatures', () => {
    const s = signFileUrl(keyring, fileId, 60, { now: 1000 });
    expect(verifySignedFileUrl(keyring, fileId, q(s.query), 1061)).toEqual({ ok: false, reason: 'signature_expired' });
  });
  it('rejects tampering with expiry, file id, disposition or signature', () => {
    const s = signFileUrl(keyring, fileId, 300);
    const params = q(s.query);
    expect(verifySignedFileUrl(keyring, fileId, { ...params, expires: String(Number(params.expires) + 1000) }).ok).toBe(false);
    expect(verifySignedFileUrl(keyring, 'file_01J9Z8Q4X5K3W2V1T0S9R8Q7P7', params).ok).toBe(false);
    expect(verifySignedFileUrl(keyring, fileId, { ...params, disposition: 'attachment' }).ok).toBe(false);
    expect(verifySignedFileUrl(keyring, fileId, { ...params, sig: params.sig!.slice(0, -2) + 'AA' }).ok).toBe(false);
  });
  it('rejects signatures from another key', () => {
    const s = signFileUrl(new Keyring({ version: 1, key: k2 }), fileId, 300);
    expect(verifySignedFileUrl(keyring, fileId, q(s.query)).ok).toBe(false);
  });
  it('rejects malformed parameters', () => {
    expect(verifySignedFileUrl(keyring, fileId, {}).ok).toBe(false);
    expect(verifySignedFileUrl(keyring, fileId, { expires: 'abc', kv: '1', sig: 'x' }).ok).toBe(false);
  });
});

describe('webhook signatures', () => {
  it('signs and verifies', () => {
    const header = signWebhookPayload('whsec_x', 'whd_1', 1000, '{"a":1}');
    expect(verifyWebhookSignature('whsec_x', 'whd_1', '{"a":1}', header, 300, 1100)).toBe(true);
    expect(verifyWebhookSignature('whsec_x', 'whd_1', '{"a":2}', header, 300, 1100)).toBe(false);
    expect(verifyWebhookSignature('whsec_x', 'whd_1', '{"a":1}', header, 300, 2000)).toBe(false);
  });
});
