import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { extensionOf } from '@cdn/shared';

/**
 * Determines the real content type from the file's leading bytes. Neither the filename,
 * the extension nor the browser-supplied Content-Type are trusted.
 */

const TEXT_TYPES_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  css: 'text/css',
  map: 'application/json',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  ini: 'text/plain',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
};

function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const sample = buf.subarray(0, 8192);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.02;
}

/** Detects markup that browsers would render as HTML/SVG/XML regardless of the name. */
function detectMarkup(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<svg[\s>]/.test(head) || (/^<\?xml/.test(head) && head.includes('<svg'))) return 'image/svg+xml';
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]|^<script[\s>]|^<iframe[\s>]/.test(head)) return 'text/html';
  if (/^<\?xml/.test(head)) return 'application/xml';
  return null;
}

export interface SniffResult {
  mime: string;
  /** Whether the type was detected from magic bytes (vs. inferred). */
  detected: boolean;
  width?: number;
  height?: number;
}

export async function sniffContent(head: Buffer, filename: string): Promise<SniffResult> {
  const ft = await fileTypeFromBuffer(head).catch(() => undefined);
  let mime: string;
  let detected = false;
  // XML is re-examined below so SVG/XHTML are classified as active content.
  if (ft && ft.mime !== 'application/xml') {
    mime = ft.mime;
    detected = true;
  } else if (looksLikeText(head)) {
    const markup = detectMarkup(head);
    if (markup) {
      mime = markup;
      detected = true;
    } else {
      const ext = extensionOf(filename);
      const byExt = TEXT_TYPES_BY_EXT[ext];
      // A text file may only claim a text-ish type; never e.g. text/html without markup.
      mime = byExt && !['text/html', 'image/svg+xml', 'application/xml'].includes(byExt) ? byExt : 'text/plain';
    }
  } else {
    mime = 'application/octet-stream';
  }
  const result: SniffResult = { mime, detected };
  if (mime.startsWith('image/')) {
    try {
      const dim = imageSize(head);
      if (dim.width && dim.height) {
        result.width = dim.width;
        result.height = dim.height;
      }
    } catch {
      // Dimensions are best-effort; some formats need more bytes than the sniff buffer.
    }
  }
  return result;
}

export const SNIFF_BYTES = 64 * 1024;
