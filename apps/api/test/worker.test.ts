import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import { closeQueues } from '../src/lib/queue.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { encryptProviderConfig, ensureDefaultProvider } from '../src/lib/storageRegistry.js';
import { invalidateZones } from '../src/lib/zones.js';
import { applyRule } from '../src/services/lifecycle.js';
import { processMedia } from '../src/services/media.js';
import { executePurge } from '../src/services/purge.js';
import { replicateFile, scheduleReplication } from '../src/services/replication.js';

/** Background pipelines invoked directly (no worker process): replication + failover, lifecycle, purges, FFmpeg. */

let app: FastifyInstance;
const prisma = () => getPrisma();
const ADMIN = { email: 'worker-admin@example.com', password: 'Worker-Passw0rd!' };
let staff: Record<string, string>;
let key: string;
let zone: { id: string; root_folder: { id: string } };
let replicaProviderId: string;

function hasFfmpeg(): boolean {
  try {
    execFileSync(env().FFMPEG_PATH, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function upload(name: string, content: Buffer, fields: Record<string, string> = {}) {
  const boundary = `----w${Date.now()}`;
  const parts = [
    ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const res = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { authorization: `Bearer ${key}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; storage_provider: { id: string } };
}

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(prisma());
  await ensureDefaultProvider();
  const founder = await prisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  await prisma().user.create({ data: { id: newId('user'), email: ADMIN.email, name: 'Worker Admin', passwordHash: await hashPassword(ADMIN.password), roles: { create: [{ roleId: founder.id }] } } });
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  staff = { cookie, 'x-csrf-token': login.json().csrf_token };
  key = (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: staff, payload: { name: 'worker', scopes: ['files:read', 'files:upload', 'files:update', 'files:delete'] } })).json().key;

  // A second local provider acts as the replica.
  replicaProviderId = newId('storageProvider');
  const root = path.resolve('.test-data', 'replica');
  await prisma().storageProvider.create({
    data: { id: replicaProviderId, name: 'Replica', kind: 'LOCAL', configEnc: encryptProviderConfig(replicaProviderId, { kind: 'LOCAL', root }), publicInfo: { root }, region: 'replica', priority: 50 },
  });
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: staff, payload: { name: 'Worker' } })).json();
  const z = await app.inject({
    method: 'POST',
    url: '/api/v1/zones',
    headers: staff,
    payload: { project_id: project.id, name: 'Replicated', default_visibility: 'PUBLIC', replication_strategy: 'FAILOVER', replica_provider_ids: [replicaProviderId], video_processing: true },
  });
  expect(z.statusCode, z.body).toBe(201);
  zone = z.json();
  invalidateZones();
});

afterAll(async () => {
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

describe('replication', () => {
  it('copies files to replicas and fails over when the primary copy is lost', async () => {
    const f = await upload('replicated.txt', Buffer.from('replicated content'), { folder_id: zone.root_folder.id });
    const file = await prisma().file.findUniqueOrThrow({ where: { id: f.id } });
    expect(await scheduleReplication(file)).toBe(1);
    await replicateFile(file.id, replicaProviderId, 1, 5);
    const replica = await prisma().fileReplica.findUniqueOrThrow({ where: { fileId_storageProviderId: { fileId: file.id, storageProviderId: replicaProviderId } } });
    expect(replica.status).toBe('SYNCED');
    expect(replica.sha256).toBe(file.sha256);

    // Lose the primary object: delivery must fall back to the replica.
    fs.rmSync(path.resolve(env().LOCAL_STORAGE_PATH, ...file.storageKey.split('/')));
    const res = await app.inject({ url: `/files/${file.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe('replicated content');
  });
});

describe('lifecycle', () => {
  it('moves matching files to the recycle bin', async () => {
    const f = await upload('old.txt', Buffer.from('old'), { folder_id: zone.root_folder.id });
    await prisma().file.update({ where: { id: f.id }, data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    const rule = await prisma().lifecycleRule.create({ data: { id: newId('lifecycleRule'), name: 'cleanup', zoneId: zone.id, afterDays: 30, action: 'TRASH' } });
    expect(await applyRule(rule)).toBeGreaterThanOrEqual(1);
    expect((await prisma().file.findUniqueOrThrow({ where: { id: f.id } })).deletedAt).not.toBeNull();
  });
});

describe('cache purges', () => {
  it('records origin-only purges when no CDN credentials are configured', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/cache/purge', headers: staff, payload: { type: 'everything' } });
    expect(res.statusCode, res.body).toBe(202);
    await executePurge(res.json().id);
    expect((await prisma().cachePurge.findUniqueOrThrow({ where: { id: res.json().id } })).status).toBe('origin_only');
  });
});

describe.skipIf(!hasFfmpeg())('media pipeline (FFmpeg)', () => {
  it('renders thumbnails, HLS and waveforms and serves them', async () => {
    const out = path.join(os.tmpdir(), `cdn-test-${Date.now()}.mp4`);
    execFileSync(env().FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out]);
    const f = await upload('clip.mp4', fs.readFileSync(out), { folder_id: zone.root_folder.id });
    fs.rmSync(out, { force: true });
    await processMedia(f.id, ['thumbnail', 'hls', 'waveform', 'audio']);
    const list = await app.inject({ url: `/api/v1/files/${f.id}/media`, headers: { authorization: `Bearer ${key}` } });
    const byKind = Object.fromEntries((list.json().data as { kind: string; status: string; url: string; error: string | null }[]).map((r) => [r.kind, r]));
    for (const k of ['thumbnail', 'hls', 'waveform', 'audio']) expect(byKind[k]?.status, `${k}: ${byKind[k]?.error}`).toBe('READY');
    const master = await app.inject({ url: new URL(byKind.hls!.url).pathname });
    expect(master.statusCode).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.body).toContain('#EXT-X-STREAM-INF');
    const rung = master.body.split('\n').find((l) => l.endsWith('.m3u8'))!;
    const playlist = await app.inject({ url: new URL(byKind.hls!.url).pathname.replace('master.m3u8', rung) });
    expect(playlist.body).toContain('#EXTINF');
    const segment = playlist.body.split('\n').find((l) => l.endsWith('.ts'))!;
    const seg = await app.inject({ url: new URL(byKind.hls!.url).pathname.replace('master.m3u8', `${rung.split('/')[0]}/${segment}`), headers: { range: 'bytes=0-187' } });
    expect(seg.statusCode).toBe(206);
    expect(seg.rawPayload[0]).toBe(0x47); // MPEG-TS sync byte
    const thumb = await app.inject({ url: new URL(byKind.thumbnail!.url).pathname });
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    const file = await prisma().file.findUniqueOrThrow({ where: { id: f.id } });
    expect(file.durationSeconds).toBeGreaterThan(1.5);
  }, 120_000);
});
