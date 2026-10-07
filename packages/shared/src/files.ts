/**
 * Filename / path normalisation and file-type policy helpers.
 * User-supplied names are display metadata only; storage keys are always derived from ids.
 */

const MAX_NAME_LENGTH = 255;
// Control chars, path separators and characters that are invalid on common filesystems.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class InvalidNameError extends Error {}

/**
 * Normalises a user supplied file or folder name:
 *  - Unicode NFC normalisation
 *  - strips any directory components (`../../etc/passwd` -> `passwd`)
 *  - removes null bytes / control characters / reserved characters
 *  - collapses whitespace, trims leading/trailing dots and spaces
 *  - rejects empty, `.`/`..` and reserved device names
 */
export function normalizeName(input: string, kind: 'file' | 'folder' = 'file'): string {
  if (typeof input !== 'string') throw new InvalidNameError('Name must be a string');
  let name = input.normalize('NFC');
  // Drop everything up to the last path separator so traversal sequences cannot survive.
  const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSep !== -1) name = name.slice(lastSep + 1);
  name = name.replace(FORBIDDEN_CHARS, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (kind === 'file' && /^\.+$/.test(name)) name = '';
  if (!name || name === '.' || name === '..') throw new InvalidNameError(`Invalid ${kind} name`);
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_LENGTH) {
    const ext = extensionOf(name);
    const base = name.slice(0, MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0));
    name = ext ? `${base}.${ext}` : base;
  }
  return name;
}

export function tryNormalizeName(input: string, kind: 'file' | 'folder' = 'file'): string | null {
  try {
    return normalizeName(input, kind);
  } catch {
    return null;
  }
}

/** Lowercase extension without the dot, or '' */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

/** Slug used for friendly URL path segments. */
export function slugifySegment(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-?\.-?/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'item';
}

/** Extensions that are never accepted regardless of configured MIME types. */
export const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'ps1', 'psm1', 'hta', 'cpl', 'jar', 'lnk', 'reg', 'sh', 'php', 'phtml', 'asp', 'aspx', 'jsp', 'cgi',
];

/**
 * Types a browser may execute or render with script access. When served from a CDN origin
 * these are always delivered with `Content-Disposition: attachment` and a sandbox CSP unless
 * an administrator explicitly allows inline rendering.
 */
export const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/x-shockwave-flash',
  'application/pdf',
]);

export function isActiveContentType(mime: string): boolean {
  return ACTIVE_CONTENT_TYPES.has(mime.split(';')[0]!.trim().toLowerCase());
}

/** `image/*` style wildcard matching. */
export function mimeMatches(pattern: string, mime: string): boolean {
  const p = pattern.trim().toLowerCase();
  const m = mime.trim().toLowerCase();
  if (p === '*' || p === '*/*') return true;
  if (p.endsWith('/*')) return m.startsWith(p.slice(0, -1));
  return p === m;
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

/** Parses sizes like `5GB`, `512mb`, `1024`. */
export function parseByteSize(input: string | number): number {
  if (typeof input === 'number') return input;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(input);
  if (!m) throw new Error(`Invalid size: ${input}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit]!;
  return Math.floor(n * mult);
}
