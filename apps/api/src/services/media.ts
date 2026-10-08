import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getPrisma, Prisma, type File, type MediaRendition } from '@cdn/database';
import { hmacSha256, newId, safeEqual } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { driverForId } from '../lib/storageRegistry.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { zoneForFolder } from '../lib/zones.js';
import { openFileStream } from './replication.js';
import { renditionObjectKeys } from './files.js';

const log = baseLogger.child({ service: 'media' });

export const RENDITION_KINDS = ['thumbnail', 'preview', 'mp4_h264', 'mp4_h265', 'webm_av1', 'hls', 'dash', 'audio', 'waveform'] as const;
export type RenditionKind = (typeof RENDITION_KINDS)[number];

const VIDEO_ONLY: RenditionKind[] = ['thumbnail', 'preview', 'mp4_h264', 'mp4_h265', 'webm_av1', 'hls', 'dash'];

export const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.json': 'application/json',
};

// ─── Access tokens for rendition URLs ───────────────────────────────────────

/**
 * Renditions such as HLS fetch many relative URLs, so access is granted per file with a token in
 * the path: /media/<file id>/<token>/<kind>/<object>. Public files use the token "pub".
 */
export function mediaToken(fileId: string, ttlSeconds: number): string {
  const kv = getKeyring().currentVersion;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmacSha256(getKeyring().subkey('media-token', kv), `v1\n${fileId}\n${exp}`).toString('base64url').slice(0, 32);
  return `${exp}.${kv}.${sig}`;
}

export function verifyMediaToken(fileId: string, token: string): boolean {
  const [expRaw, kvRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  const kv = Number(kvRaw);
  if (!sig || !Number.isInteger(exp) || !Number.isInteger(kv) || !getKeyring().hasVersion(kv) || exp < Date.now() / 1000) return false;
  const expected = hmacSha256(getKeyring().subkey('media-token', kv), `v1\n${fileId}\n${exp}`).toString('base64url').slice(0, 32);
  return safeEqual(expected, sig);
}

// ─── ffmpeg helpers ─────────────────────────────────────────────────────────

function run(bin: string, args: string[], opts: { timeoutMs?: number; collectStdout?: boolean } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (opts.collectStdout) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 6 * 3600_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(bin)} could not be started: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${err.split('\n').slice(-6).join(' ').trim()}`));
    });
  });
}

export interface ProbeResult {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  bitRate: number | null;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(env().FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { collectStdout: true, timeoutMs: 60_000 });
  const data = JSON.parse(stdout.toString()) as { format?: { duration?: string; bit_rate?: string }; streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[] };
  const video = data.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(data.format?.duration ?? 0),
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitRate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
  };
}

/** Approximate target bitrate (kbit/s) for an H.264 ladder rung. */
function ladderBitrate(height: number): number {
  if (height <= 240) return 400;
  if (height <= 360) return 800;
  if (height <= 480) return 1400;
  if (height <= 720) return 2800;
  if (height <= 1080) return 5000;
  if (height <= 1440) return 9000;
  return 16000;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

interface RenderOutput {
  files: string[];
  entry?: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown>;
}

async function renderKind(kind: RenditionKind, src: string, outDir: string, info: ProbeResult, ladder: number[]): Promise<RenderOutput> {
  const ff = env().FFMPEG_PATH;
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  const seek = String(Math.max(0, Math.min(info.duration * 0.1, Math.max(0, info.duration - 1))).toFixed(2));
  await fs.mkdir(outDir, { recursive: true });
  switch (kind) {
    case 'thumbnail': {
      await run(ff, [...base, '-ss', seek, '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', path.join(outDir, 'thumbnail.jpg')]);
      const w = Math.min(1280, info.width ?? 1280);
      return { files: ['thumbnail.jpg'], mimeType: 'image/jpeg', width: w, height: info.width && info.height ? even((info.height * w) / info.width) : null };
    }
    case 'preview': {
      await run(ff, [...base, '-ss', seek, '-t', '6', '-i', src, '-an', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(outDir, 'preview.mp4')]);
      return { files: ['preview.mp4'], mimeType: 'video/mp4', height: 360 };
    }
    case 'mp4_h264': {
      await run(ff, [...base, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(outDir, 'video.mp4')]);
      return { files: ['video.mp4'], mimeType: 'video/mp4', width: info.width, height: info.height, metadata: { codec: 'h264' } };
    }
    case 'mp4_h265': {
      await run(ff, [...base, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx265', '-preset', 'medium', '-crf', '28', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(outDir, 'video.mp4')]);
      return { files: ['video.mp4'], mimeType: 'video/mp4', width: info.width, height: info.height, metadata: { codec: 'hevc' } };
    }
    case 'webm_av1': {
      await run(ff, [...base, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libsvtav1', '-crf', '35', '-preset', '8', '-c:a', 'libopus', '-b:a', '128k', path.join(outDir, 'video.webm')]);
      return { files: ['video.webm'], mimeType: 'video/webm', width: info.width, height: info.height, metadata: { codec: 'av1' } };
    }
    case 'hls': {
      const srcH = info.height ?? 720;
      const rungs = [...new Set(ladder.filter((h) => h <= srcH))].sort((a, b) => a - b);
      if (rungs.length === 0) rungs.push(even(srcH));
      const files: string[] = [];
      const variants: { height: number; width: number; bandwidth: number }[] = [];
      for (const h of rungs) {
        const dir = path.join(outDir, `${h}p`);
        await fs.mkdir(dir, { recursive: true });
        const kbps = ladderBitrate(h);
        await run(ff, [
          ...base, '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'seg_%04d.ts'), path.join(dir, 'index.m3u8'),
        ]);
        for (const f of await fs.readdir(dir)) files.push(`${h}p/${f}`);
        const w = info.width && info.height ? even((info.width * h) / info.height) : even((h * 16) / 9);
        variants.push({ height: h, width: w, bandwidth: (kbps + 128) * 1000 });
      }
      const master = ['#EXTM3U', '#EXT-X-VERSION:3', ...variants.flatMap((v) => [`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="avc1.640028,mp4a.40.2"`, `${v.height}p/index.m3u8`])].join('\n');
      await fs.writeFile(path.join(outDir, 'master.m3u8'), `${master}\n`);
      files.push('master.m3u8');
      return { files, entry: 'master.m3u8', mimeType: 'application/vnd.apple.mpegurl', width: info.width, height: info.height, metadata: { ladder: variants } };
    }
    case 'dash': {
      const h = Math.min(info.height ?? 720, Math.max(...ladder));
      await run(ff, [
        ...base, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k',
        '-f', 'dash', '-seg_duration', '4', '-use_template', '1', '-use_timeline', '1', '-init_seg_name', 'init-$RepresentationID$.m4s', '-media_seg_name', 'chunk-$RepresentationID$-$Number%05d$.m4s', path.join(outDir, 'manifest.mpd'),
      ]);
      return { files: await fs.readdir(outDir), entry: 'manifest.mpd', mimeType: 'application/dash+xml', height: h };
    }
    case 'audio': {
      await run(ff, [...base, '-i', src, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(outDir, 'audio.m4a')]);
      return { files: ['audio.m4a'], mimeType: 'audio/mp4' };
    }
    case 'waveform': {
      await run(ff, [...base, '-i', src, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1800x240:colors=#6366f1', '-frames:v', '1', path.join(outDir, 'waveform.png')]);
      // Peak data for interactive players: 1000 normalised peaks from 8 kHz mono PCM.
      const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { collectStdout: true });
      const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
      const buckets = 1000;
      const per = Math.max(1, Math.floor(samples.length / buckets));
      const peaks: number[] = [];
      for (let i = 0; i < buckets && i * per < samples.length; i++) {
        let max = 0;
        for (let j = i * per; j < Math.min(samples.length, (i + 1) * per); j++) max = Math.max(max, Math.abs(samples[j]!));
        peaks.push(Math.round((max / 32768) * 1000) / 1000);
      }
      await fs.writeFile(path.join(outDir, 'peaks.json'), JSON.stringify({ peaks, duration: info.duration }));
      return { files: ['waveform.png', 'peaks.json'], entry: 'waveform.png', mimeType: 'image/png', width: 1800, height: 240, metadata: { peaks_file: 'peaks.json' } };
    }
  }
}

/** Kinds applicable to a probed file. */
export function applicableKinds(kinds: RenditionKind[], info: ProbeResult): RenditionKind[] {
  return kinds.filter((k) => {
    if (VIDEO_ONLY.includes(k)) return info.hasVideo;
    if (k === 'audio' || k === 'waveform') return info.hasAudio;
    return true;
  });
}

export async function mediaProcessingEnabled(file: Pick<File, 'folderId' | 'mimeType'>): Promise<boolean> {
  if (!file.mimeType.startsWith('video/') && !file.mimeType.startsWith('audio/')) return false;
  const settings = await getSettings();
  if (settings.media.enabled) return true;
  const zone = await zoneForFolder(file.folderId);
  return Boolean(zone?.videoProcessing);
}

/** Worker entry point: renders the requested (or configured) renditions for a file. */
export async function processMedia(fileId: string, requested?: string[]): Promise<void> {
  const prisma = getPrisma();
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || file.status !== 'READY' || file.deletedAt) return;
  const settings = await getSettings();
  const work = path.resolve(env().UPLOAD_TMP_PATH, 'media', `${file.id}-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const src = path.join(work, 'source');
    await pipeline((await openFileStream(file, null)).stream, createWriteStream(src));
    const info = await probe(src);
    if (info.duration > settings.media.maxDurationSeconds) {
      log.info({ file_id: file.id, duration: info.duration }, 'media longer than the configured maximum; skipped');
      return;
    }
    if (!file.durationSeconds && info.duration) await prisma.file.update({ where: { id: file.id }, data: { durationSeconds: Math.round(info.duration * 1000) / 1000, width: file.width ?? info.width, height: file.height ?? info.height } });
    const wanted = (requested?.length ? requested : settings.media.renditions).filter((k): k is RenditionKind => (RENDITION_KINDS as readonly string[]).includes(k));
    const kinds = applicableKinds(wanted, info);
    const { driver } = await driverForId(file.storageProviderId);
    for (const kind of kinds) {
      const prefix = `media/${file.id}/${kind}`;
      const existing = await prisma.mediaRendition.findUnique({ where: { fileId_kind: { fileId: file.id, kind } } });
      const row = await prisma.mediaRendition.upsert({
        where: { fileId_kind: { fileId: file.id, kind } },
        create: { id: newId('rendition'), fileId: file.id, kind, status: 'PROCESSING', storageProviderId: file.storageProviderId, storageKey: prefix },
        update: { status: 'PROCESSING', error: null },
      });
      try {
        const outDir = path.join(work, kind);
        const out = await renderKind(kind, src, outDir, info, settings.media.ladder);
        let size = 0;
        for (const rel of out.files) {
          const abs = path.join(outDir, ...rel.split('/'));
          const stat = await fs.stat(abs);
          size += stat.size;
          await driver.put(`${prefix}/${rel}`, createReadStream(abs), { contentType: CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream', size: stat.size });
        }
        // Objects from a previous render that are no longer produced are removed.
        if (existing?.status === 'READY') {
          const stale = renditionObjectKeys(existing).filter((k) => !out.files.map((f) => `${prefix}/${f}`).includes(k));
          for (const key of stale) await driver.delete(key).catch(() => undefined);
        }
        await prisma.mediaRendition.update({
          where: { id: row.id },
          data: {
            status: 'READY',
            entry: out.entry ?? out.files[0] ?? null,
            mimeType: out.mimeType,
            size: BigInt(size),
            width: out.width ?? null,
            height: out.height ?? null,
            durationSeconds: info.duration || null,
            metadata: { ...(out.metadata ?? {}), files: out.files } as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        log.warn({ file_id: file.id, kind, err: (err as Error).message }, 'rendition failed');
        await prisma.mediaRendition.update({ where: { id: row.id }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 1000) } });
      }
    }
    const zone = await zoneForFolder(file.folderId);
    const ready = await prisma.mediaRendition.findMany({ where: { fileId: file.id, status: 'READY' }, select: { kind: true } });
    if (ready.length) await emitWebhookEvent('media.ready', { file_id: file.id, renditions: ready.map((r) => r.kind) }, { projectId: zone?.projectId });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export function serializeRendition(r: MediaRendition, baseUrl: string, token: string) {
  const files = (r.metadata as { files?: string[] } | null)?.files ?? [];
  const url = (f: string) => `${baseUrl}/media/${r.fileId}/${token}/${r.kind}/${f}`;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    error: r.error,
    mime_type: r.mimeType,
    size: Number(r.size),
    width: r.width,
    height: r.height,
    duration_seconds: r.durationSeconds,
    url: r.status === 'READY' && r.entry ? url(r.entry) : null,
    files: r.status === 'READY' ? files.length : 0,
    metadata: Object.fromEntries(Object.entries((r.metadata as Record<string, unknown>) ?? {}).filter(([k]) => k !== 'files')),
    peaks_url: r.kind === 'waveform' && r.status === 'READY' ? url('peaks.json') : undefined,
    updated_at: r.updatedAt.toISOString(),
  };
}
