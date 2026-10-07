import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createHash } from 'node:crypto';
import { getPrisma, seedDatabase, disconnectPrisma } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { getRedis, closeRedis } from '../src/lib/redis.js';
import { closeQueues } from '../src/lib/queue.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';
import { invalidateSettingsCache } from '../src/lib/settings.js';

let app: FastifyInstance;
const prisma = () => getPrisma();
const ADMIN = { email: 'founder@example.com', password: 'Founder-Passw0rd!' };
const VIEWER = { email: 'viewer@example.com', password: 'Viewer-Passw0rd!' };

interface Session {
  cookie: string;
  csrf: string;
}

function multipart(files: { name: string; content: Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----cdntest${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`));
    parts.push(f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds });
  expect(res.statusCode, res.body).toBe(200);
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  return { cookie, csrf: res.json().csrf_token };
}

function asStaff(s: Session) {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf };
}

async function createKey(s: Session, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: asStaff(s), payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { api_key: { id: string; prefix: string }; key: string };
}

async function upload(key: string, name: string, content: Buffer, fields: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const mp = multipart([{ name, content }], fields);
  return app.inject({ method: 'POST', url: '/api/v1/files', headers: { authorization: `Bearer ${key}`, ...mp.headers }, payload: mp.payload });
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000808060000001ff3ff610000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(prisma());
  await ensureDefaultProvider();
  const founder = await prisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  const viewer = await prisma().role.findUniqueOrThrow({ where: { name: 'Viewer' } });
  await prisma().user.create({ data: { id: newId('user'), email: ADMIN.email, name: 'Founder', passwordHash: await hashPassword(ADMIN.password), roles: { create: [{ roleId: founder.id }] } } });
  await prisma().user.create({ data: { id: newId('user'), email: VIEWER.email, name: 'Viewer', passwordHash: await hashPassword(VIEWER.password), roles: { create: [{ roleId: viewer.id }] } } });
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

describe('health', () => {
  it('reports ready without leaking details', async () => {
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok', storage: 'ok' } });
  });
  it('sets a request id on every response', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('staff authentication', () => {
  it('rejects bad credentials with a generic error and logs the failure', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ADMIN.email, password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    const audit = await prisma().auditLog.findFirst({ where: { action: 'LOGIN_FAILED' } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.metadata)).not.toContain('nope');
  });

  it('logs in with an HttpOnly cookie and exposes the CSRF token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.json().permissions).toContain('settings.edit');
  });

  it('requires CSRF tokens for cookie-authenticated mutations', async () => {
    const s = await login(ADMIN);
    const noToken = await app.inject({ method: 'POST', url: '/api/v1/folders', headers: { cookie: s.cookie }, payload: { name: 'x' } });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error.code).toBe('csrf_failed');
    const badOrigin = await app.inject({ method: 'POST', url: '/api/v1/folders', headers: { ...asStaff(s), origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(badOrigin.json().error.code).toBe('csrf_failed');
  });

  it('revokes the session on logout', async () => {
    const s = await login(ADMIN);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: asStaff(s) });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ url: '/api/v1/auth/session', headers: { cookie: s.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('locks out after repeated failures (brute-force protection)', async () => {
    const email = 'nobody@example.com';
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 12; i++) last = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong-password' } });
    expect(last!.statusCode).toBe(429);
  });
});

describe('RBAC', () => {
  it('denies actions outside the role (server-side)', async () => {
    const v = await login(VIEWER);
    const res = await app.inject({ method: 'POST', url: '/api/v1/folders', headers: asStaff(v), payload: { name: 'nope' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    const keys = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: v.cookie } });
    expect(keys.statusCode).toBe(403);
  });

  it('prevents privilege escalation through custom roles', async () => {
    const s = await login(ADMIN);
    // Founder can create; but a Viewer (no roles.manage) cannot even list roles.
    const v = await login(VIEWER);
    expect((await app.inject({ url: '/api/v1/roles', headers: { cookie: v.cookie } })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/v1/roles', headers: asStaff(s), payload: { name: 'Release', permissions: ['files.view', 'files.upload'] } });
    expect(created.statusCode).toBe(201);
  });
});

describe('API keys', () => {
  let admin: Session;
  beforeAll(async () => {
    admin = await login(ADMIN);
  });

  it('shows the key once and stores only a hash', async () => {
    const { api_key, key } = await createKey(admin, { name: 'ci', scopes: ['files:read'] });
    expect(key).toMatch(/^cdn_live_[0-9A-Za-z]{32}$/);
    const row = await prisma().apiKey.findUniqueOrThrow({ where: { id: api_key.id } });
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toContain(key.slice(9));
    const list = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: admin.cookie } });
    expect(list.body).not.toContain(key);
    expect(list.json().data[0].masked_key).toMatch(/^cdn_live_.{4}•+$/);
  });

  it('authenticates with Bearer and returns consistent errors', async () => {
    const { key } = await createKey(admin, { name: 'me', scopes: ['files:read'] });
    const me = await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${key}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().scopes).toEqual(['files:read']);
    const bad = await app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer cdn_live_' + 'x'.repeat(32) } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_api_key', message: 'The supplied API key is invalid.' } });
    expect(bad.json().error.request_id).toMatch(/^req_/);
  });

  it('rejects revoked keys', async () => {
    const { api_key, key } = await createKey(admin, { name: 'revoke-me', scopes: ['files:read'] });
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${api_key.id}`, headers: asStaff(admin) });
    expect(del.statusCode).toBe(200);
    const res = await app.inject({ url: '/api/v1/files', headers: { authorization: `Bearer ${key}` } });
    expect(res.json().error.code).toBe('api_key_revoked');
  });

  it('rejects expired keys', async () => {
    const { api_key, key } = await createKey(admin, { name: 'expire-me', scopes: ['files:read'] });
    await prisma().apiKey.update({ where: { id: api_key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await app.inject({ url: '/api/v1/files', headers: { authorization: `Bearer ${key}` } });
    expect(res.json().error.code).toBe('api_key_expired');
  });

  it('enforces scopes', async () => {
    const { key } = await createKey(admin, { name: 'read-only', scopes: ['files:read'] });
    const res = await upload(key, 'a.txt', Buffer.from('hello'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('blocks administrative endpoints for API keys', async () => {
    const { key } = await createKey(admin, { name: 'all', scopes: ['files:read', 'files:upload', 'analytics:read'] });
    const res = await app.inject({ url: '/api/v1/api-keys', headers: { authorization: `Bearer ${key}` } });
    expect(res.json().error.code).toBe('staff_session_required');
  });

  it('enforces IP restrictions', async () => {
    const { key } = await createKey(admin, { name: 'ip', scopes: ['files:read'], ip_restrictions: ['203.0.113.0/24'] });
    const res = await app.inject({ url: '/api/v1/files', headers: { authorization: `Bearer ${key}` } });
    expect(res.json().error.code).toBe('ip_not_allowed');
  });

  it('enforces endpoint restrictions', async () => {
    const { key } = await createKey(admin, { name: 'ep', scopes: ['files:read', 'folders:read'], allowed_endpoints: ['GET /api/v1/files*'] });
    expect((await app.inject({ url: '/api/v1/files', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/folders', headers: { authorization: `Bearer ${key}` } })).json().error.code).toBe('endpoint_not_allowed');
  });

  it('rate limits per key with headers and 429', async () => {
    const { key } = await createKey(admin, { name: 'slow', scopes: ['files:read'], rate_limit: 3 });
    const statuses: number[] = [];
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 5; i++) {
      last = await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${key}` } });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(last!.headers['x-ratelimit-limit']).toBe('3');
    expect(last!.headers['x-ratelimit-remaining']).toBe('0');
    expect(last!.headers['x-ratelimit-reset']).toBeDefined();
    expect(last!.json().error.code).toBe('rate_limited');
  });

  it('rotates keys', async () => {
    const { api_key, key } = await createKey(admin, { name: 'rotate', scopes: ['files:read'] });
    const rot = await app.inject({ method: 'POST', url: `/api/v1/api-keys/${api_key.id}/rotate`, headers: asStaff(admin), payload: {} });
    expect(rot.statusCode).toBe(201);
    const newKey = rot.json().key as string;
    expect((await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${newKey}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${key}` } })).json().error.code).toBe('api_key_revoked');
  });
});

describe('files, delivery and signed URLs', () => {
  let admin: Session;
  let key: string;
  beforeAll(async () => {
    admin = await login(ADMIN);
    key = (await createKey(admin, { name: 'files', scopes: ['files:read', 'files:upload', 'files:update', 'files:delete', 'folders:read', 'folders:write', 'metadata:read'] })).key;
  });

  it('uploads, detects real type and computes SHA-256', async () => {
    const res = await upload(key, 'image.txt', PNG, { visibility: 'PUBLIC' });
    expect(res.statusCode, res.body).toBe(201);
    const f = res.json();
    expect(f.id).toMatch(/^file_/);
    expect(f.mime_type).toBe('image/png');
    expect(f.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(f.size).toBe(PNG.length);
    expect(f.status).toBe('READY');
    expect(f.url).toBe(`http://cdn.test/files/${f.id}`);
  });

  it('serves public files with caching headers, HEAD, ranges and 304', async () => {
    const f = (await upload(key, 'logo.png', PNG, { visibility: 'PUBLIC' })).json();
    const get = await app.inject({ url: `/files/${f.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(PNG)).toBe(true);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['etag']).toBe(`"${f.sha256}"`);
    expect(get.headers['accept-ranges']).toBe('bytes');
    expect(get.headers['cache-control']).toContain('max-age=31536000');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    const head = await app.inject({ method: 'HEAD', url: `/files/${f.id}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(PNG.length));
    expect(head.body).toBe('');
    const range = await app.inject({ url: `/files/${f.id}`, headers: { range: 'bytes=0-7' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-7/${PNG.length}`);
    expect(range.rawPayload.equals(PNG.subarray(0, 8))).toBe(true);
    const bad = await app.inject({ url: `/files/${f.id}`, headers: { range: 'bytes=9999-' } });
    expect(bad.statusCode).toBe(416);
    const cond = await app.inject({ url: `/files/${f.id}`, headers: { 'if-none-match': get.headers['etag'] as string } });
    expect(cond.statusCode).toBe(304);
  });

  it('serves friendly paths', async () => {
    const folder = await app.inject({ method: 'POST', url: '/api/v1/folders', headers: { authorization: `Bearer ${key}` }, payload: { name: 'Assets', visibility: 'PUBLIC' } });
    expect(folder.statusCode, folder.body).toBe(201);
    const f = (await upload(key, 'Brand Logo.png', PNG, { folder_id: folder.json().id })).json();
    expect(f.path_url).toBe('http://cdn.test/p/assets/brand-logo.png');
    expect((await app.inject({ url: '/p/assets/brand-logo.png' })).statusCode).toBe(200);
  });

  it('protects private files', async () => {
    const f = (await upload(key, 'secret.png', PNG, { visibility: 'PRIVATE' })).json();
    expect((await app.inject({ url: `/files/${f.id}` })).statusCode).toBe(401);
    const ok = await app.inject({ url: `/files/${f.id}`, headers: { authorization: `Bearer ${key}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
  });

  it('issues signed URLs that expire and cannot be forged', async () => {
    const f = (await upload(key, 'signed.png', PNG, { visibility: 'SIGNED_URL_ONLY' })).json();
    expect((await app.inject({ url: `/files/${f.id}`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
    const signed = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/signed-url`, headers: { authorization: `Bearer ${key}` }, payload: { expires_in: 60 } });
    expect(signed.statusCode, signed.body).toBe(200);
    const url = new URL(signed.json().url);
    expect((await app.inject({ url: url.pathname + url.search })).statusCode).toBe(200);
    const forged = new URLSearchParams(url.search);
    forged.set('expires', String(Number(forged.get('expires')) + 3600));
    const forgedRes = await app.inject({ url: `${url.pathname}?${forged}` });
    expect(forgedRes.json().error.code).toBe('invalid_signature');
    // Simulate expiry by signing in the past.
    const { signFileUrl } = await import('@cdn/shared');
    const { getKeyring } = await import('../src/config/env.js');
    const past = signFileUrl(getKeyring(), f.id, 10, { now: Math.floor(Date.now() / 1000) - 3600 });
    const expired = await app.inject({ url: `/files/${f.id}?${past.query}` });
    expect(expired.json().error.code).toBe('signature_expired');
  });

  it('forces attachment and sandbox for HTML/SVG uploads', async () => {
    const f = (await upload(key, 'cat.png', Buffer.from('<!doctype html><script>alert(document.cookie)</script>'), { visibility: 'PUBLIC' })).json();
    expect(f.mime_type).toBe('text/html');
    const res = await app.inject({ url: `/files/${f.id}` });
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('rejects blocked extensions and checksum mismatches', async () => {
    expect((await upload(key, 'tool.exe', Buffer.from('MZ...'))).json().error.code).toBe('unsupported_file_type');
    expect((await upload(key, 'a.txt', Buffer.from('abc'), { sha256: '0'.repeat(64) })).json().error.code).toBe('checksum_mismatch');
  });

  it('enforces the upload size limit', async () => {
    const { updateSettingsSection } = await import('../src/lib/settings.js');
    await updateSettingsSection('uploads', { maxFileSize: 1024 }, null);
    const res = await upload(key, 'big.bin', Buffer.alloc(4096, 1));
    expect(res.statusCode).toBe(413);
    await updateSettingsSection('uploads', { maxFileSize: 5 * 1024 ** 3 }, null);
    invalidateSettingsCache();
  });

  it('rejects malformed ids and traversal attempts', async () => {
    for (const url of ['/files/..%2F..%2Fetc%2Fpasswd', '/files/file_123', "/files/file_01J9Z8Q4X5K3W2V1T0S9R8Q7P6'--"]) {
      const res = await app.inject({ url });
      expect([400, 404]).toContain(res.statusCode);
    }
    expect((await app.inject({ url: '/api/v1/files/not-an-id', headers: { authorization: `Bearer ${key}` } })).json().error.code).toBe('invalid_id');
    expect((await app.inject({ url: '/p/../../etc/passwd' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/p/%2e%2e/%2e%2e/etc/passwd' })).statusCode).toBe(404);
  });

  it('renames, moves, copies and deletes', async () => {
    const f = (await upload(key, 'orig.png', PNG)).json();
    const ren = await app.inject({ method: 'PATCH', url: `/api/v1/files/${f.id}`, headers: { authorization: `Bearer ${key}` }, payload: { name: 'renamed.png' } });
    expect(ren.json().name).toBe('renamed.png');
    const fld = (await app.inject({ method: 'POST', url: '/api/v1/folders', headers: { authorization: `Bearer ${key}` }, payload: { name: 'Moved' } })).json();
    const mv = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/move`, headers: { authorization: `Bearer ${key}` }, payload: { folder_id: fld.id } });
    expect(mv.json().folder_id).toBe(fld.id);
    const cp = await app.inject({ method: 'POST', url: `/api/v1/files/${f.id}/copy`, headers: { authorization: `Bearer ${key}` }, payload: { folder_id: 'root' } });
    expect(cp.statusCode).toBe(201);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: { authorization: `Bearer ${key}` } });
    expect(del.statusCode).toBe(204);
    // The copy still serves the shared object.
    expect((await app.inject({ url: `/api/v1/files/${cp.json().id}/download`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/files/${f.id}`, headers: { authorization: `Bearer ${key}` } })).json().error.code).toBe('file_not_found');
    const audit = await prisma().auditLog.findFirst({ where: { action: 'FILE_DELETE', targetId: f.id } });
    expect(audit).not.toBeNull();
  });

  it('supports chunked uploads with checksum verification', async () => {
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7);
    const sha = createHash('sha256').update(data).digest('hex');
    const init = await app.inject({ method: 'POST', url: '/api/v1/uploads/init', headers: { authorization: `Bearer ${key}` }, payload: { filename: 'big.bin', size: data.length, sha256: sha, chunk_size: 1024 * 1024 } });
    expect(init.statusCode, init.body).toBe(201);
    const up = init.json();
    expect(up.total_chunks).toBe(3);
    for (const i of [2, 0, 1]) {
      const chunk = data.subarray(i * 1024 * 1024, Math.min(data.length, (i + 1) * 1024 * 1024));
      const res = await app.inject({ method: 'POST', url: `/api/v1/uploads/${up.id}/chunk?index=${i}`, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' }, payload: chunk });
      expect(res.statusCode, res.body).toBe(200);
    }
    const done = await app.inject({ method: 'POST', url: `/api/v1/uploads/${up.id}/complete`, headers: { authorization: `Bearer ${key}` } });
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json().sha256).toBe(sha);
    expect(done.json().size).toBe(data.length);
  });

  it('rejects a wrong-sized chunk', async () => {
    const init = (await app.inject({ method: 'POST', url: '/api/v1/uploads/init', headers: { authorization: `Bearer ${key}` }, payload: { filename: 'x.bin', size: 3 * 1024 * 1024, chunk_size: 1024 * 1024 } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/uploads/${init.id}/chunk?index=0`, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) });
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('records analytics for deliveries', async () => {
    await flushRequests();
    const count = await prisma().fileRequest.count({ where: { kind: 'delivery' } });
    expect(count).toBeGreaterThan(0);
    const s = await login(ADMIN);
    const res = await app.inject({ url: '/api/v1/analytics?period=24h', headers: { cookie: s.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.requests).toBeGreaterThan(0);
    const overview = await app.inject({ url: '/api/v1/dashboard/overview?period=7d', headers: { cookie: s.cookie } });
    expect(overview.statusCode, overview.body).toBe(200);
  });
});

describe('audit log immutability', () => {
  it('blocks updates and deletes at the database level', async () => {
    const row = await prisma().auditLog.findFirstOrThrow();
    await expect(prisma().auditLog.update({ where: { id: row.id }, data: { action: 'TAMPERED' } })).rejects.toThrow();
    await expect(prisma().auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
  });
});

describe('OpenAPI', () => {
  it('documents every endpoint with examples in four languages', async () => {
    const doc = (await app.inject({ url: '/openapi.json' })).json();
    expect(doc.openapi).toBe('3.1.0');
    const op = doc.paths['/api/v1/files'].post;
    expect(op['x-required-scopes']).toEqual(['files:upload']);
    expect(op['x-codeSamples'].map((s: { label: string }) => s.label)).toEqual(['curl', 'JavaScript', 'Node.js', 'Python']);
    expect(doc.paths['/api/v1/files/{id}/signed-url']).toBeDefined();
  });
});
