import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Master key management.
 *
 * The application master key (32 random bytes, base64) comes from the environment or a
 * secrets manager. It is never used directly: purpose-specific subkeys are derived with
 * HKDF-SHA256 so a compromise of one derived key does not expose the others.
 *
 * Every key has a numeric version. Ciphertexts and API-key hashes record the version they
 * were produced with, so the master key can be rotated by adding a new current key while
 * keeping previous keys available for decryption/verification.
 */

export type KeyPurpose = 'field-encryption' | 'api-key-hash' | 'signed-url' | 'session' | 'csrf' | 'token-hash';

export interface MasterKeyInput {
  version: number;
  key: Buffer;
}

export class Keyring {
  readonly currentVersion: number;
  private readonly masters = new Map<number, Buffer>();
  private readonly derived = new Map<string, Buffer>();

  constructor(current: MasterKeyInput, previous: MasterKeyInput[] = []) {
    for (const k of [current, ...previous]) {
      if (!Number.isInteger(k.version) || k.version < 1) {
        throw new Error('Master key versions must be positive integers');
      }
      if (k.key.length !== 32) {
        throw new Error(`Master key v${k.version} must be exactly 32 bytes (got ${k.key.length})`);
      }
      if (this.masters.has(k.version)) throw new Error(`Duplicate master key version ${k.version}`);
      this.masters.set(k.version, k.key);
    }
    this.currentVersion = current.version;
  }

  /**
   * Parses keys from environment-style strings.
   * @param currentB64 base64 encoded 32-byte key
   * @param previous comma separated list of `version:base64key`
   */
  static fromEnv(currentB64: string, currentVersion = 1, previous = ''): Keyring {
    const decode = (b64: string) => Buffer.from(b64.trim(), 'base64');
    const prev = previous
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf(':');
        if (idx === -1) throw new Error('Previous master keys must be formatted as version:base64key');
        return { version: Number(entry.slice(0, idx)), key: decode(entry.slice(idx + 1)) };
      });
    return new Keyring({ version: currentVersion, key: decode(currentB64) }, prev);
  }

  hasVersion(version: number): boolean {
    return this.masters.has(version);
  }

  versions(): number[] {
    return [...this.masters.keys()].sort((a, b) => b - a);
  }

  /** Returns a 32-byte subkey for the given purpose and key version. */
  subkey(purpose: KeyPurpose, version = this.currentVersion): Buffer {
    const cacheKey = `${purpose}:${version}`;
    let key = this.derived.get(cacheKey);
    if (!key) {
      const master = this.masters.get(version);
      if (!master) throw new Error(`Unknown master key version ${version}`);
      key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `cdnserver:${purpose}:v1`, 32));
      this.derived.set(cacheKey, key);
    }
    return key;
  }
}

/**
 * AES-256-GCM authenticated field encryption.
 *
 * Serialised format (all parts base64url):
 *   enc.v1.<keyVersion>.<iv 12 bytes>.<auth tag 16 bytes>.<ciphertext>
 *
 * The optional `aad` (additional authenticated data) binds a ciphertext to its context
 * (e.g. `storage_provider:<id>`), preventing ciphertexts from being swapped between rows.
 */
const FORMAT_PREFIX = 'enc.v1';

export function encryptField(keyring: Keyring, plaintext: string, aad?: string): string {
  const version = keyring.currentVersion;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.subkey('field-encryption', version), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_PREFIX, String(version), iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function parseEncryptedField(value: string): { keyVersion: number; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const parts = value.split('.');
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== FORMAT_PREFIX) {
    throw new Error('Malformed encrypted value');
  }
  const keyVersion = Number(parts[2]);
  const iv = Buffer.from(parts[3]!, 'base64url');
  const tag = Buffer.from(parts[4]!, 'base64url');
  const ciphertext = Buffer.from(parts[5]!, 'base64url');
  if (!Number.isInteger(keyVersion) || iv.length !== 12 || tag.length !== 16) {
    throw new Error('Malformed encrypted value');
  }
  return { keyVersion, iv, tag, ciphertext };
}

export function decryptField(keyring: Keyring, value: string, aad?: string): string {
  const { keyVersion, iv, tag, ciphertext } = parseEncryptedField(value);
  if (!keyring.hasVersion(keyVersion)) throw new Error(`Encrypted with unknown key version ${keyVersion}`);
  const decipher = createDecipheriv('aes-256-gcm', keyring.subkey('field-encryption', keyVersion), iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** True when the value was encrypted with an older key and should be re-encrypted. */
export function needsReencryption(keyring: Keyring, value: string): boolean {
  return parseEncryptedField(value).keyVersion !== keyring.currentVersion;
}

export function encryptJson(keyring: Keyring, value: unknown, aad?: string): string {
  return encryptField(keyring, JSON.stringify(value), aad);
}

export function decryptJson<T>(keyring: Keyring, value: string, aad?: string): T {
  return JSON.parse(decryptField(keyring, value, aad)) as T;
}
