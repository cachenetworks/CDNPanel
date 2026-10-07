import { ulid } from 'ulid';

/**
 * Resource identifiers are a short type prefix plus a ULID
 * (48-bit timestamp + 80 bits from the platform CSPRNG), e.g. `file_01J9Z...`.
 * They are lexicographically sortable and safe to put in URLs.
 */
export const ID_PREFIXES = {
  user: 'usr',
  role: 'role',
  session: 'ses',
  apiKey: 'key',
  file: 'file',
  folder: 'fld',
  upload: 'upl',
  storageProvider: 'stp',
  auditLog: 'aud',
  securityEvent: 'sev',
  webhook: 'whk',
  webhookDelivery: 'whd',
  request: 'req',
  userToken: 'tok',
  recoveryCode: 'rcv',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

const ULID_RE = '[0-9A-HJKMNP-TV-Z]{26}';
const ID_RE_CACHE = new Map<IdKind, RegExp>();

/** Strictly validates that `value` is a well-formed id of the given kind. */
export function isValidId(kind: IdKind, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  let re = ID_RE_CACHE.get(kind);
  if (!re) {
    re = new RegExp(`^${ID_PREFIXES[kind]}_${ULID_RE}$`);
    ID_RE_CACHE.set(kind, re);
  }
  return re.test(value);
}
