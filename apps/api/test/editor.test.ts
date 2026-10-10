import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { closeQueues } from '../src/lib/queue.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';
import { decodeText, isEditableType } from '../src/lib/textFiles.js';

/** Browser text editor: open, save as a revision, conflict detection, binary refusal. */

let app: FastifyInstance;
let key: string;

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(getPrisma());
  await ensureDefaultProvider();
  const founder = await getPrisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  const email = 'editor-admin@example.com';
  await getPrisma().user.create({ data: { id: newId('user'), email, name: 'Editor', passwordHash: await hashPassword('Editor-Passw0rd!'), roles: { create: [{ roleId: founder.id }] } } });
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Editor-Passw0rd!' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrf_token };
  const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'editor', scopes: ['files:read', 'files:upload', 'files:update'] } });
  key = res.json().key;
});

afterAll(async () => {
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

const auth = () => ({ authorization: `Bearer ${key}` });

async function upload(name: string, content: Buffer) {
  const boundary = `----ed${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; editable: boolean; version: number; url: string };
}

describe('text detection', () => {
  it('recognises text types and rejects binary content', () => {
    expect(isEditableType({ mimeType: 'application/json', extension: 'json' })).toBe(true);
    expect(isEditableType({ mimeType: 'application/octet-stream', extension: 'luau' })).toBe(true);
    expect(isEditableType({ mimeType: 'image/png', extension: 'png' })).toBe(false);
    expect(decodeText(Buffer.from('héllo ✓'))).toBe('héllo ✓');
    expect(decodeText(Buffer.from([0x68, 0x00, 0x69]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe('browser text editor', () => {
  it('opens a text file and saves edits as a new revision', async () => {
    const original = '{\n  "name": "launcher",\n  "version": 1\n}\n';
    const file = await upload('config.json', Buffer.from(original));
    expect(file.editable).toBe(true);

    const opened = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/text`, headers: auth() });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ content: original, version: 1, mime_type: 'application/json' });

    const edited = original.replace('"version": 1', '"version": 2');
    const saved = await app.inject({ method: 'PUT', url: `/api/v1/files/${file.id}/text`, headers: auth(), payload: { content: edited, base_version: 1 } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ id: file.id, version: 2, mime_type: 'application/json', url: file.url });

    const download = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/download`, headers: auth() });
    expect(download.body).toBe(edited);

    // The previous content is kept as a revision.
    const versions = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/versions`, headers: auth() });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().data.map((v: { version: number }) => v.version)).toContain(1);

    // Saving from a stale copy is refused instead of overwriting someone else's edit.
    const stale = await app.inject({ method: 'PUT', url: `/api/v1/files/${file.id}/text`, headers: auth(), payload: { content: 'oops', base_version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/text`, headers: auth() })).json().content).toBe(edited);
  });

  it('refuses binary and non-text files', async () => {
    const png = await upload('pixel.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4510000000049454e44ae426082', 'hex'));
    expect(png.editable).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${png.id}/text`, headers: auth() })).statusCode).toBe(422);
    const fake = await upload('data.txt', Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${fake.id}/text`, headers: auth() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/UTF-8/);
  });
});
