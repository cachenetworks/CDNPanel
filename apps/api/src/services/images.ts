import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { getPrisma, type File, type ImageVariant } from '@cdn/database';
import { AppError, hmacSha256, newId, safeEqual } from '@cdn/shared';
import { getKeyring } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';
import type { Settings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { openFileStream } from './replication.js';

/**
 * Image optimisation engine.
 *
 *   /img/<file id>?w=800&h=600&fit=cover&format=webp&q=80[&s=<signature>]
 *
 * Parameters are normalised into a canonical string; the variant is generated once with sharp,
 * stored next to the original and reused for every later request (keyed by source SHA-256 +
 * canonical parameters). Signatures (HMAC of file id + canonical parameters) stop clients from
 * generating unlimited variants.
 */

export const FITS = ['cover', 'contain', 'fill', 'inside', 'outside'] as const;
export const POSITIONS = ['center', 'top', 'right top', 'right', 'right bottom', 'bottom', 'left bottom', 'left', 'left top', 'attention', 'entropy'] as const;
export const FORMATS = ['auto', 'webp', 'avif', 'jpeg', 'png'] as const;
export const GRAVITY = ['center', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

export interface TransformParams {
  w?: number;
  h?: number;
  dpr?: number;
  fit?: (typeof FITS)[number];
  pos?: (typeof POSITIONS)[number];
  format?: (typeof FORMATS)[number];
  q?: number;
  rotate?: 0 | 90 | 180 | 270;
  flip?: boolean;
  flop?: boolean;
  blur?: number;
  sharpen?: number;
  /** Extract region before resizing: x,y,w,h in source pixels. */
  crop?: [number, number, number, number];
  bg?: string;
  grayscale?: boolean;
  /** Watermark: file id of a (PNG/WebP) image in the library. */
  wm?: string;
  wm_pos?: (typeof GRAVITY)[number];
  wm_opacity?: number;
  /** Watermark width as a fraction of the output width. */
  wm_scale?: number;
  /** Keep EXIF / ICC metadata (stripped by default). */
  keep_meta?: boolean;
}

/** Raster formats sharp can decode safely. SVG is deliberately excluded (active content). */
export const TRANSFORMABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff', 'image/heif', 'image/heic']);

const PARAM_KEYS = ['w', 'h', 'dpr', 'fit', 'pos', 'format', 'q', 'rotate', 'flip', 'flop', 'blur', 'sharpen', 'crop', 'bg', 'grayscale', 'wm', 'wm_pos', 'wm_opacity', 'wm_scale', 'keep_meta'] as const;

function int(v: string, min: number, max: number, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError('transform_invalid', `${name} must be an integer between ${min} and ${max}.`);
  return n;
}
function float(v: string, min: number, max: number, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new AppError('transform_invalid', `${name} must be between ${min} and ${max}.`);
  return Math.round(n * 100) / 100;
}
function bool(v: string): boolean {
  return v === '1' || v === 'true' || v === '';
}
function oneOf<T extends readonly string[]>(v: string, list: T, name: string): T[number] {
  if (!(list as readonly string[]).includes(v)) throw new AppError('transform_invalid', `${name} must be one of: ${list.join(', ')}.`);
  return v as T[number];
}

/** Parses and validates query parameters (unknown keys are ignored, except for signing). */
export function parseTransform(query: Record<string, unknown>, settings: Settings): TransformParams {
  const q = (k: string) => (typeof query[k] === 'string' ? (query[k] as string) : undefined);
  const p: TransformParams = {};
  const max = Math.max(settings.images.maxWidth, settings.images.maxHeight);
  if (q('w')) p.w = int(q('w')!, 1, settings.images.maxWidth, 'w');
  if (q('h')) p.h = int(q('h')!, 1, settings.images.maxHeight, 'h');
  if (q('dpr')) p.dpr = float(q('dpr')!, 1, 4, 'dpr');
  if (q('fit')) p.fit = oneOf(q('fit')!, FITS, 'fit');
  if (q('pos')) p.pos = oneOf(q('pos')!.replace(/[-_]/g, ' '), POSITIONS, 'pos');
  if (q('format')) p.format = oneOf(q('format')!, FORMATS, 'format');
  if (q('q')) p.q = int(q('q')!, 1, 100, 'q');
  if (q('rotate')) p.rotate = oneOf(q('rotate')!, ['0', '90', '180', '270'] as const, 'rotate') === '0' ? 0 : (Number(q('rotate')) as 90 | 180 | 270);
  if (q('flip') !== undefined) p.flip = bool(q('flip')!);
  if (q('flop') !== undefined) p.flop = bool(q('flop')!);
  if (q('blur')) p.blur = float(q('blur')!, 0.3, 100, 'blur');
  if (q('sharpen')) p.sharpen = float(q('sharpen')!, 0.5, 10, 'sharpen');
  if (q('crop')) {
    const parts = q('crop')!.split(',').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 100_000) || parts[2]! < 1 || parts[3]! < 1) {
      throw new AppError('transform_invalid', 'crop must be x,y,width,height in pixels.');
    }
    p.crop = parts as [number, number, number, number];
  }
  if (q('bg')) {
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(q('bg')!)) throw new AppError('transform_invalid', 'bg must be a hex colour such as ffffff.');
    p.bg = q('bg')!.toLowerCase();
  }
  if (q('grayscale') !== undefined) p.grayscale = bool(q('grayscale')!);
  if (q('wm')) {
    if (!/^file_[0-9A-HJKMNP-TV-Z]{26}$/.test(q('wm')!)) throw new AppError('transform_invalid', 'wm must be a file id.');
    p.wm = q('wm');
  }
  if (q('wm_pos')) p.wm_pos = oneOf(q('wm_pos')!, GRAVITY, 'wm_pos');
  if (q('wm_opacity')) p.wm_opacity = float(q('wm_opacity')!, 0.05, 1, 'wm_opacity');
  if (q('wm_scale')) p.wm_scale = float(q('wm_scale')!, 0.02, 1, 'wm_scale');
  if (q('keep_meta') !== undefined) p.keep_meta = bool(q('keep_meta')!);
  const outW = (p.w ?? 0) * (p.dpr ?? 1);
  const outH = (p.h ?? 0) * (p.dpr ?? 1);
  if (outW > max || outH > max) throw new AppError('transform_invalid', `Output dimensions must not exceed ${max}px.`);
  return p;
}

/** Stable, ordered representation used for signatures and cache keys. */
export function canonicalTransform(p: TransformParams): string {
  const parts: string[] = [];
  for (const k of PARAM_KEYS) {
    const v = p[k];
    if (v === undefined || v === false) continue;
    parts.push(`${k}=${Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v)}`);
  }
  return parts.join('&');
}

export function signTransform(fileId: string, canonical: string, kv = getKeyring().currentVersion): string {
  const sig = hmacSha256(getKeyring().subkey('image-transform', kv), `v1\n${fileId}\n${canonical}`).toString('base64url').slice(0, 32);
  return `${kv}.${sig}`;
}

export function verifyTransformSignature(fileId: string, canonical: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length > 64) return false;
  const [kvRaw, sig] = signature.split('.');
  const kv = Number(kvRaw);
  if (!sig || !Number.isInteger(kv) || !getKeyring().hasVersion(kv)) return false;
  return safeEqual(signTransform(fileId, canonical, kv), signature);
}

export function transformQuery(canonical: string, signature?: string): string {
  return signature ? (canonical ? `${canonical}&s=${encodeURIComponent(signature)}` : `s=${encodeURIComponent(signature)}`) : canonical;
}

/** Resolves format=auto from the Accept header (the result is part of the variant key). */
export function resolveFormat(p: TransformParams, sourceMime: string, accept: string | undefined): 'webp' | 'avif' | 'jpeg' | 'png' | 'gif' {
  if (p.format && p.format !== 'auto') return p.format;
  if (p.format === 'auto') {
    if (accept?.includes('image/avif')) return 'avif';
    if (accept?.includes('image/webp')) return 'webp';
  }
  if (sourceMime === 'image/png') return 'png';
  if (sourceMime === 'image/gif' && !p.format) return 'gif';
  if (sourceMime === 'image/webp') return 'webp';
  if (sourceMime === 'image/avif') return 'avif';
  return 'jpeg';
}

const MIME: Record<string, string> = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

export function variantHash(file: Pick<File, 'id' | 'sha256'>, canonical: string, format: string): string {
  return createHash('sha256').update(`v1|${file.sha256 ?? file.id}|${canonical}|${format}`).digest('hex').slice(0, 40);
}

async function toBuffer(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    len += b.length;
    if (len > max) {
      stream.destroy();
      throw new AppError('transform_unsupported', 'The source image is too large to transform.');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

/** Runs the sharp pipeline. Exported for tests. */
export async function renderImage(source: Buffer, p: TransformParams, format: string, settings: Settings, watermark?: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  let img = sharp(source, { limitInputPixels: settings.images.maxSourcePixels, animated: format === 'gif' || format === 'webp', failOn: 'error' });
  img = img.rotate(); // apply EXIF orientation first
  if (p.crop) img = img.extract({ left: p.crop[0], top: p.crop[1], width: p.crop[2], height: p.crop[3] });
  if (p.rotate) img = img.rotate(p.rotate);
  if (p.flip) img = img.flip();
  if (p.flop) img = img.flop();
  const dpr = p.dpr ?? 1;
  if (p.w || p.h) {
    img = img.resize({
      width: p.w ? Math.round(p.w * dpr) : undefined,
      height: p.h ? Math.round(p.h * dpr) : undefined,
      fit: p.fit ?? 'cover',
      position: p.pos ?? 'center',
      withoutEnlargement: true,
      background: p.bg ? `#${p.bg}` : { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  if (p.grayscale) img = img.grayscale();
  if (p.blur) img = img.blur(p.blur);
  if (p.sharpen) img = img.sharpen({ sigma: p.sharpen });
  if (p.bg && (format === 'jpeg')) img = img.flatten({ background: `#${p.bg}` });
  if (watermark) {
    // Size the watermark relative to the output image.
    const base = await img.clone().toBuffer({ resolveWithObject: true });
    const targetW = Math.max(16, Math.round(base.info.width * (p.wm_scale ?? 0.25)));
    let wm = sharp(watermark, { limitInputPixels: 50_000_000 }).resize({ width: Math.min(targetW, base.info.width), height: base.info.height, fit: 'inside', withoutEnlargement: false }).ensureAlpha();
    if (p.wm_opacity !== undefined && p.wm_opacity < 1) {
      wm = wm.composite([{ input: Buffer.from([255, 255, 255, Math.round(255 * p.wm_opacity)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]);
    }
    img = sharp(base.data).composite([{ input: await wm.png().toBuffer(), gravity: p.wm_pos ?? 'southeast' }]);
  }
  const quality = p.q ?? settings.images.defaultQuality;
  switch (format) {
    case 'webp':
      img = img.webp({ quality });
      break;
    case 'avif':
      img = img.avif({ quality: Math.max(1, Math.round(quality * 0.75)), effort: 4 });
      break;
    case 'png':
      img = img.png({ compressionLevel: 9, palette: quality < 100 });
      break;
    case 'gif':
      img = img.gif();
      break;
    default:
      img = img.jpeg({ quality, mozjpeg: true });
  }
  if (p.keep_meta || !settings.images.stripMetadata) img = img.keepMetadata();
  const out = await img.toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
}

const inflight = new Map<string, Promise<ImageVariant>>();

/**
 * Returns the stored variant for (file, params, format), generating it on first use.
 * Concurrent requests for the same new variant share one render.
 */
export async function getOrCreateVariant(file: File, p: TransformParams, canonical: string, format: string, settings: Settings): Promise<{ variant: ImageVariant; created: boolean; cpuMs: number }> {
  const prisma = getPrisma();
  const hash = variantHash(file, canonical, format);
  const existing = await prisma.imageVariant.findUnique({ where: { fileId_paramsHash: { fileId: file.id, paramsHash: hash } } });
  if (existing) return { variant: existing, created: false, cpuMs: 0 };
  const key = `${file.id}:${hash}`;
  let job = inflight.get(key);
  let started = 0;
  if (!job) {
    started = Date.now();
    job = (async () => {
      const { stream } = await openFileStream(file, null);
      const source = await toBuffer(stream, MAX_SOURCE_BYTES);
      let watermark: Buffer | undefined;
      if (p.wm) {
        const wmFile = await prisma.file.findUnique({ where: { id: p.wm } });
        if (!wmFile || wmFile.status !== 'READY' || wmFile.deletedAt || !TRANSFORMABLE.has(wmFile.mimeType)) throw new AppError('transform_invalid', 'The watermark file does not exist or is not an image.');
        watermark = await toBuffer((await openFileStream(wmFile, null)).stream, 20 * 1024 * 1024);
      }
      let out;
      try {
        out = await renderImage(source, p, format, settings, watermark);
      } catch (err) {
        if (err instanceof AppError) throw err;
        baseLogger.warn({ err: (err as Error).message, file_id: file.id }, 'image transform failed');
        throw new AppError('transform_unsupported', 'The image could not be transformed.');
      }
      const storageKey = `variants/${file.id}/${hash}.${format === 'jpeg' ? 'jpg' : format}`;
      const { driver } = await driverForId(file.storageProviderId);
      await driver.put(storageKey, out.data, { contentType: MIME[format]!, size: out.data.length });
      return prisma.imageVariant.upsert({
        where: { fileId_paramsHash: { fileId: file.id, paramsHash: hash } },
        create: { id: newId('imageVariant'), fileId: file.id, paramsHash: hash, params: { canonical, format }, storageProviderId: file.storageProviderId, storageKey, mimeType: MIME[format]!, size: BigInt(out.data.length), width: out.width, height: out.height },
        update: {},
      });
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const variant = await job;
  return { variant, created: started > 0, cpuMs: started > 0 ? Date.now() - started : 0 };
}

/** Deletes all stored variants of a file (after its content changes). */
export async function purgeVariants(fileId: string): Promise<number> {
  const prisma = getPrisma();
  const variants = await prisma.imageVariant.findMany({ where: { fileId } });
  for (const v of variants) {
    try {
      const { driver } = await driverForId(v.storageProviderId);
      await driver.delete(v.storageKey);
    } catch (err) {
      baseLogger.warn({ err, key: v.storageKey }, 'failed to delete image variant');
    }
  }
  await prisma.imageVariant.deleteMany({ where: { fileId } });
  return variants.length;
}

/** Removes variants not requested for `days` (worker job) to bound storage. */
export async function garbageCollectVariants(days = 90, batch = 1000): Promise<number> {
  const prisma = getPrisma();
  const stale = await prisma.imageVariant.findMany({ where: { lastAccessedAt: { lt: new Date(Date.now() - days * 86_400_000) } }, take: batch });
  for (const v of stale) {
    try {
      const { driver } = await driverForId(v.storageProviderId);
      await driver.delete(v.storageKey);
    } catch {
      /* object already gone */
    }
  }
  await prisma.imageVariant.deleteMany({ where: { id: { in: stale.map((v) => v.id) } } });
  return stale.length;
}
