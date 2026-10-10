import type { File } from '@cdn/database';

/** Text files that can be opened in the browser editor. */

/** Largest file the browser editor opens or saves. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

const TEXT_MIME = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'application/x-subrip',
  'image/svg+xml',
]);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonc', 'json5', 'map', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'svg', 'vtt', 'srt', 'sql', 'graphql',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'luau', 'sh', 'ps1', 'bat', 'dockerfile', 'properties', 'gitignore', 'htaccess',
]);

/** Whether a file is plausibly text the browser editor can handle (content is checked when it is opened). */
export function isEditableType(file: Pick<File, 'mimeType' | 'extension'>): boolean {
  const mime = file.mimeType.split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('text/') || TEXT_MIME.has(mime) || mime.endsWith('+json') || mime.endsWith('+xml')) return true;
  return TEXT_EXTENSIONS.has((file.extension ?? '').toLowerCase());
}

/** Decodes UTF-8 strictly; returns null for binary content (invalid UTF-8 or NUL bytes). */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** True when the browser editor can open this file (type and size; the content is checked on open). */
export function isEditable(file: Pick<File, 'mimeType' | 'extension' | 'size'>): boolean {
  return isEditableType(file) && Number(file.size) <= MAX_EDITABLE_BYTES;
}
