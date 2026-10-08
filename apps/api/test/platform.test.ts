import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { getPrisma, seedDatabase, disconnectPrisma } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { closeQueues } from '../src/lib/queue.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';
import { invalidateSettingsCache } from '../src/lib/settings.js';

/** Integration tests for the 2.0 platform: zones, domains, cache, images, shares, revisions, security, usage, ops. */

let app: FastifyInstance;
const prisma = () => getPrisma();
const ADMIN = { email: 'platform-admin@example.com', password: 'Platform-Passw0rd!' };
const HOST = 'assets.example.test';

interface Session {
  cookie: string;
  csrf: string;
}
let s: Session;
let key: string;
let zone: { id: string; root_folder: { id: string; path: string }; slug: string };
let otherFile: { id: string };
let zoneFile: { id: string; slug: string };

function multipart(files: { name: string; content: Buffer }[], fields: Record<string, string> = {}) {
  const boundary = `----cdnplatform${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const staff = () => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
const bearer = (k = key) => ({ authorization: `Bearer ${k}` });

async function upload(name: string, content: Buffer, fields: Record<string, string> = {}, k = key): Promise<LightMyRequestResponse> {
  const mp = multipart([{ name, content }], fields);
  return app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...bearer(k), ...mp.headers }, payload: mp.payload });
}

let png: Buffer;

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(prisma());
  await ensureDefaultProvider();
  const founder = await prisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  await prisma().user.create({ data: { id: newId('user'), email: ADMIN.email, name: 'Platform Admin', passwordHash: await hashPassword(ADMIN.password), roles: { create: [{ roleId: founder.id }] } } });
  invalidateSettingsCache();
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
  expect(login.statusCode, login.body).toBe(200);
  const setCookie = login.headers['set-cookie'];
  s = { cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!, csrf: login.json().csrf_token };
  // Every action below requires a recent password confirmation.
  await app.inject({ method: 'POST', url: '/api/v1/auth/reauth', headers: staff(), payload: { password: ADMIN.password } });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/api-keys',
    headers: staff(),
    payload: { name: 'platform', scopes: ['files:read', 'files:upload', 'files:update', 'files:delete', 'folders:read', 'folders:write', 'zones:read', 'zones:write', 'cache:purge', 'shares:write', 'usage:read', 'metadata:write'] },
  });
  expect(created.statusCode, created.body).toBe(201);
  key = created.json().key;
  png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#2266ff' } }).png().toBuffer();
});

afterAll(async () => {
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

describe('projects, zones and custom domains', () => {
  it('creates a project and a zone with its own root folder', async () => {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: staff(), payload: { name: 'Sentinel' } });
    expect(project.statusCode, project.body).toBe(201);
    const z = await app.inject({ method: 'POST', url: '/api/v1/zones', headers: staff(), payload: { project_id: project.json().id, name: 'Sentinel Assets', edge_ttl: 7200, browser_ttl: 120, default_visibility: 'PUBLIC' } });
    expect(z.statusCode, z.body).toBe(201);
    zone = z.json();
    expect(zone.root_folder.path).toBe('/sentinel-assets');
  });

  it('verifies a domain and serves zone-relative paths on it', async () => {
    const d = await app.inject({ method: 'POST', url: `/api/v1/zones/${zone.id}/domains`, headers: staff(), payload: { hostname: `https://${HOST.toUpperCase()}/` } });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json().hostname).toBe(HOST);
    expect(d.json().verification.txt.name).toBe(`_cdnpanel-challenge.${HOST}`);
    const v = await app.inject({ method: 'POST', url: `/api/v1/domains/${d.json().id}/verify`, headers: staff() });
    expect(v.json().domain.status).toBe('ACTIVE');

    const up = await upload('logo.png', png, { folder_id: zone.root_folder.id });
    expect(up.statusCode, up.body).toBe(201);
    zoneFile = up.json();
    expect(up.json().visibility).toBe('PUBLIC');

    const res = await app.inject({ url: '/_zone/logo.png', headers: { host: HOST } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-cdn-zone']).toBe(zone.slug);
    expect(res.headers['cache-control']).toBe('public, max-age=120');
    expect(res.headers['cdn-cache-control']).toBe('max-age=7200');
    expect(String(res.headers['cache-tag'])).toContain(`file:${zoneFile.id}`);
  });

  it('isolates zones on custom domains', async () => {
    otherFile = (await upload('outside.png', png, { visibility: 'PUBLIC' })).json();
    expect((await app.inject({ url: `/files/${otherFile.id}`, headers: { host: HOST } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/files/${otherFile.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: '/_zone/logo.png', headers: { host: 'unknown.example.test' } })).statusCode).toBe(404);
  });

  it('applies cache rules', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/zones/${zone.id}/cache-rules`, headers: staff(), payload: { name: 'no png', pattern: '*.png', bypass: true } });
    expect(r.statusCode, r.body).toBe(201);
    const res = await app.inject({ url: `/files/${zoneFile.id}` });
    expect(res.headers['cdn-cache-control']).toBe('no-store');
    await app.inject({ method: 'DELETE', url: `/api/v1/cache-rules/${r.json().id}`, headers: staff() });
  });

  it('enforces hotlink protection', async () => {
    await app.inject({ method: 'PATCH', url: `/api/v1/zones/${zone.id}`, headers: staff(), payload: { allowed_referrers: ['*.good.example'], allow_empty_referrer: false } });
    expect((await app.inject({ url: `/files/${zoneFile.id}`, headers: { referer: 'https://evil.example/page' } })).json().error.code).toBe('access_denied');
    expect((await app.inject({ url: `/files/${zoneFile.id}` })).statusCode).toBe(403);
    expect((await app.inject({ url: `/files/${zoneFile.id}`, headers: { referer: 'https://www.good.example/page' } })).statusCode).toBe(200);
    await app.inject({ method: 'PATCH', url: `/api/v1/zones/${zone.id}`, headers: staff(), payload: { allowed_referrers: [], allow_empty_referrer: true } });
  });

  it('confines project-bound API keys to their zones', async () => {
    const z = await app.inject({ url: `/api/v1/zones/${zone.id}`, headers: staff() });
    const k = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: staff(), payload: { name: 'project key', scopes: ['files:read', 'files:upload', 'zones:read'], project_id: z.json().project_id } });
    expect(k.statusCode, k.body).toBe(201);
    const pk = k.json().key;
    const list = await app.inject({ url: '/api/v1/files?limit=100', headers: bearer(pk) });
    expect(list.json().data.map((f: { id: string }) => f.id)).toContain(zoneFile.id);
    expect(list.json().data.map((f: { id: string }) => f.id)).not.toContain(otherFile.id);
    expect((await app.inject({ url: `/api/v1/files/${otherFile.id}`, headers: bearer(pk) })).statusCode).toBe(404);
    // Uploads without a folder land in the project's zone.
    const up = await upload('auto.png', png, {}, pk);
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().folder_id).toBe(zone.root_folder.id);
    expect((await app.inject({ url: '/api/v1/zones', headers: bearer(pk) })).json().data).toHaveLength(1);
  });

  it('queues cache purges and explains cache policies', async () => {
    const p = await app.inject({ method: 'POST', url: '/api/v1/cache/purge', headers: bearer(), payload: { type: 'file', targets: [zoneFile.id] } });
    expect(p.statusCode, p.body).toBe(202);
    expect(p.json().status).toBe('pending');
    const explain = await app.inject({ url: `/api/v1/files/${zoneFile.id}/cache`, headers: bearer() });
    expect(explain.json().urls).toContain(`https://${HOST}/logo.png`);
    expect((await app.inject({ url: '/api/v1/cache/stats', headers: staff() })).statusCode).toBe(200);
  });
});

describe('image optimisation', () => {
  it('requires signed transformation URLs and caches variants', async () => {
    expect((await app.inject({ url: `/img/${zoneFile.id}?w=16&format=webp` })).json().error.code).toBe('invalid_signature');
    const signed = await app.inject({ method: 'POST', url: '/api/v1/images/sign', headers: bearer(), payload: { file_id: zoneFile.id, params: { w: 16, format: 'webp' } } });
    expect(signed.statusCode, signed.body).toBe(200);
    const path = new URL(signed.json().url);
    expect(path.host).toBe(HOST);
    const first = await app.inject({ url: `${path.pathname}${path.search}` });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toBe('image/webp');
    expect(first.headers['x-cdn-variant']).toBe('MISS');
    const meta = await sharp(first.rawPayload).metadata();
    expect(meta.width).toBe(16);
    const second = await app.inject({ url: `${path.pathname}${path.search}` });
    expect(second.headers['x-cdn-variant']).toBe('HIT');
    expect((await app.inject({ url: `/api/v1/files/${zoneFile.id}/variants`, headers: bearer() })).json().data).toHaveLength(1);
  });
});

describe('revisions and the recycle bin', () => {
  it('uploads a new revision and rolls back', async () => {
    const original = (await upload('doc.txt', Buffer.from('version one'), { visibility: 'PUBLIC' })).json();
    const mp = multipart([{ name: 'doc.txt', content: Buffer.from('version two') }]);
    const rev = await app.inject({ method: 'POST', url: `/api/v1/files/${original.id}/versions`, headers: { ...bearer(), ...mp.headers }, payload: mp.payload });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(rev.json().version).toBe(2);
    expect((await app.inject({ url: `/files/${original.id}` })).body).toBe('version two');
    const versions = await app.inject({ url: `/api/v1/files/${original.id}/versions`, headers: bearer() });
    expect(versions.json().data).toHaveLength(1);
    const restore = await app.inject({ method: 'POST', url: `/api/v1/files/${original.id}/versions/1/restore`, headers: bearer() });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json().version).toBe(3);
    expect((await app.inject({ url: `/files/${original.id}` })).body).toBe('version one');
  });

  it('trashes and restores files', async () => {
    const f = (await upload('trash-me.txt', Buffer.from('bye'), { visibility: 'PUBLIC' })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: bearer() })).statusCode).toBe(204);
    expect((await app.inject({ url: `/files/${f.id}` })).statusCode).toBe(404);
    const trash = await app.inject({ url: '/api/v1/trash', headers: bearer() });
    expect(trash.json().data.map((x: { id: string }) => x.id)).toContain(f.id);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/restore`, headers: bearer(), payload: {} });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await app.inject({ url: `/files/${f.id}` })).body).toBe('bye');
  });

  it('expires files and previews lifecycle rules', async () => {
    const f = (await upload('temp.txt', Buffer.from('tmp'), { expires_in_days: '1' })).json();
    expect(f.expires_at).not.toBeNull();
    const rule = await app.inject({ method: 'POST', url: '/api/v1/lifecycle-rules', headers: staff(), payload: { name: 'old', after_days: 30, action: 'TRASH' } });
    expect(rule.statusCode, rule.body).toBe(201);
    const preview = await app.inject({ url: `/api/v1/lifecycle-rules/${rule.json().id}/preview`, headers: staff() });
    expect(preview.json().matches).toBe(0);
  });
});

describe('share links', () => {
  it('protects downloads with a password and a download limit', async () => {
    const f = (await upload('secret.txt', Buffer.from('top secret'))).json();
    const share = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/shares`, headers: bearer(), payload: { password: 'hunter22', max_downloads: 1, title: 'For you' } });
    expect(share.statusCode, share.body).toBe(201);
    const url = new URL(share.json().url);
    const page = await app.inject({ url: url.pathname });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('For you');
    expect((await app.inject({ url: `${url.pathname}/download` })).json().error.code).toBe('share_password_required');
    const wrong = await app.inject({ method: 'POST', url: `${url.pathname}/unlock`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=nope' });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: `${url.pathname}/unlock`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=hunter22' });
    expect(ok.statusCode).toBe(303);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    const dl = await app.inject({ url: `${url.pathname}/download`, headers: { cookie } });
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.body).toBe('top secret');
    expect(dl.headers['cache-control']).toContain('private');
    expect((await app.inject({ url: `${url.pathname}/download`, headers: { cookie } })).json().error.code).toBe('share_expired');
    const detail = await app.inject({ url: `/api/v1/shares/${share.json().id}`, headers: bearer() });
    expect(detail.json().download_count).toBe(1);
    expect(detail.json().accesses.some((a: { downloaded: boolean }) => a.downloaded)).toBe(true);
  });

  it('revokes one-time links after the first download', async () => {
    const f = (await upload('once.txt', Buffer.from('once'))).json();
    const share = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/shares`, headers: bearer(), payload: { one_time: true } });
    const path = new URL(share.json().url).pathname;
    expect((await app.inject({ url: `${path}/download` })).statusCode).toBe(200);
    expect((await app.inject({ url: `${path}/download` })).statusCode).toBe(404);
  });
});

describe('edge security', () => {
  it('bans IPs everywhere and lifts bans', async () => {
    const ban = await app.inject({ method: 'POST', url: '/api/v1/security/bans', headers: staff(), payload: { cidr: '203.0.113.9', reason: 'test', minutes: 5 } });
    expect(ban.statusCode, ban.body).toBe(201);
    expect((await app.inject({ url: `/files/${otherFile.id}`, remoteAddress: '203.0.113.9' })).json().error.code).toBe('access_denied');
    expect((await app.inject({ url: '/health', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/api/v1/security/bans/${ban.json().id}`, headers: staff() });
    expect((await app.inject({ url: `/files/${otherFile.id}`, remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
  });

  it('applies WAF rules and dry-runs them', async () => {
    const rule = await app.inject({
      method: 'POST',
      url: '/api/v1/security/rules',
      headers: staff(),
      payload: { name: 'bad bots', conditions: [{ field: 'user_agent', op: 'contains', value: 'badbot' }], action: 'BLOCK' },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    expect((await app.inject({ url: `/files/${otherFile.id}`, headers: { 'user-agent': 'BadBot/1.0' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/files/${otherFile.id}`, headers: { 'user-agent': 'Mozilla/5.0' } })).statusCode).toBe(200);
    const test = await app.inject({ method: 'POST', url: '/api/v1/security/rules/test', headers: staff(), payload: { user_agent: 'badbot' } });
    expect(test.json().outcome).toBe('block');
    const challenge = await app.inject({ method: 'PATCH', url: `/api/v1/security/rules/${rule.json().id}`, headers: staff(), payload: { action: 'CHALLENGE' } });
    expect(challenge.statusCode).toBe(200);
    const page = await app.inject({ url: `/files/${otherFile.id}`, headers: { 'user-agent': 'badbot' } });
    expect(page.headers['x-cdn-challenge']).toBe('1');
    await app.inject({ method: 'DELETE', url: `/api/v1/security/rules/${rule.json().id}`, headers: staff() });
  });

  it('grants folder access with signed cookies', async () => {
    const f = (await upload('member.txt', Buffer.from('members only'), { folder_id: zone.root_folder.id, visibility: 'PRIVATE' })).json();
    expect((await app.inject({ url: `/files/${f.id}` })).statusCode).toBe(401);
    const c = await app.inject({ method: 'POST', url: '/api/v1/signed-cookies', headers: bearer(), payload: { folder_id: zone.root_folder.id } });
    expect(c.statusCode, c.body).toBe(200);
    const res = await app.inject({ url: `/files/${f.id}`, headers: { cookie: `cdn_access=${c.json().value}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('members only');
  });
});

describe('usage, quotas and operations', () => {
  it('reports usage and enforces hard quotas', async () => {
    await flushRequests();
    const usage = await app.inject({ url: `/api/v1/usage?scope_type=zone&scope_id=${zone.id}`, headers: bearer() });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.json().usage.requests).toBeGreaterThan(0);
    expect(usage.json().usage.storage_bytes).toBeGreaterThan(0);
    const q = await app.inject({ method: 'POST', url: '/api/v1/quotas', headers: staff(), payload: { scope_type: 'zone', scope_id: zone.id, metric: 'requests', limit: 1, hard: true } });
    expect(q.statusCode, q.body).toBe(201);
    expect((await app.inject({ url: `/files/${zoneFile.id}` })).json().error.code).toBe('quota_exceeded');
    await app.inject({ method: 'DELETE', url: `/api/v1/quotas/${q.json().id}`, headers: staff() });
    expect((await app.inject({ url: `/files/${zoneFile.id}` })).statusCode).toBe(200);
  });

  it('exposes operations data, metrics and the asset inspector', async () => {
    const ops = await app.inject({ url: '/api/v1/ops/overview', headers: staff() });
    expect(ops.statusCode, ops.body).toBe(200);
    expect(ops.json().dependencies.postgres.ok).toBe(true);
    expect(ops.json().queues.map((q: { name: string }) => q.name)).toContain('media');
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('cdn_http_request_duration_seconds');
    expect((await app.inject({ url: '/metrics', remoteAddress: '198.51.100.20' })).statusCode).toBe(404);
    const inspect = await app.inject({ method: 'POST', url: '/api/v1/ops/inspect', headers: staff(), payload: { url: `https://${HOST}/logo.png`, country: 'AU' } });
    expect(inspect.statusCode, inspect.body).toBe(200);
    expect(inspect.json().verdict).toBe('served');
    expect(inspect.json().steps.map((st: { stage: string }) => st.stage)).toEqual(expect.arrayContaining(['host', 'route', 'file', 'zone', 'security', 'auth', 'storage', 'cache']));
    const geo = await app.inject({ url: '/api/v1/analytics/geo', headers: staff() });
    expect(geo.statusCode).toBe(200);
  });

  it('manages service accounts, key templates and webhook replays', async () => {
    const t = await app.inject({ method: 'POST', url: '/api/v1/api-key-templates', headers: staff(), payload: { name: 'CI', scopes: ['files:read', 'files:upload'], expires_in_days: 30 } });
    expect(t.statusCode, t.body).toBe(201);
    const sa = await app.inject({ method: 'POST', url: '/api/v1/service-accounts', headers: staff(), payload: { name: 'github-actions' } });
    expect(sa.statusCode, sa.body).toBe(201);
    const k = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: staff(), payload: { name: 'ci', template_id: t.json().id, service_account_id: sa.json().id } });
    expect(k.statusCode, k.body).toBe(201);
    expect(k.json().api_key.scopes).toEqual(['files:read', 'files:upload']);
    expect(k.json().api_key.service_account_id).toBe(sa.json().id);
    // Disabling the service account disables its keys.
    await app.inject({ method: 'PATCH', url: `/api/v1/service-accounts/${sa.json().id}`, headers: staff(), payload: { enabled: false } });
    expect((await app.inject({ url: '/api/v1/files', headers: bearer(k.json().key) })).json().error.code).toBe('api_key_disabled');

    const hook = await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: staff(), payload: { name: 'h', url: 'https://hooks.example.com/x', events: ['file.uploaded'] } });
    expect(hook.statusCode, hook.body).toBe(201);
    const sample = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${hook.json().webhook.id}/test-event`, headers: staff(), payload: { event: 'quota.threshold' } });
    expect(sample.statusCode, sample.body).toBe(202);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/webhooks/deliveries/${sample.json().delivery_id}/replay`, headers: staff() });
    expect(replay.statusCode, replay.body).toBe(202);
    const row = await prisma().webhookDelivery.findUniqueOrThrow({ where: { id: replay.json().delivery_id } });
    expect((row.payload as { replay_of: string }).replay_of).toBe(sample.json().delivery_id);
  });
});
