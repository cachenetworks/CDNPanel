import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { closeQueues } from '../src/lib/queue.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';

/** Authenticated downloads over a real socket: full, ranged, aborted and concurrent transfers must never double-send. */

let app: FastifyInstance;
let baseUrl: string;
let key: string;
const serverErrors: unknown[] = [];

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(getPrisma());
  await ensureDefaultProvider();
  const founder = await getPrisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  const email = 'dl-admin@example.com';
  await getPrisma().user.create({ data: { id: newId('user'), email, name: 'DL', passwordHash: await hashPassword('Dl-Passw0rd!xxx'), roles: { create: [{ roleId: founder.id }] } } });
  app = await buildApp();
  app.addHook('onError', async (_req, _reply, err) => {
    serverErrors.push(err);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Dl-Passw0rd!xxx' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrf_token };
  const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'dl', scopes: ['files:read', 'files:upload', 'shares:write'] } });
  key = res.json().key;
});

afterAll(async () => {
  // Aborted clients can leave sockets in the HTTP keep-alive pool. Close them
  // explicitly so test shutdown does not wait indefinitely for those clients.
  app?.server.closeAllConnections();
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

async function upload(name: string, content: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  const res = await fetch(`${baseUrl}/api/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('authenticated downloads', () => {
  it('survives full, ranged, aborted and concurrent transfers', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 3);
    const bigId = await upload('big.bin', big);
    const smallId = await upload('small.json', Buffer.from('{"ok":true}'));
    const url = (id: string) => `${baseUrl}/api/v1/files/${id}/download`;
    const auth = { authorization: `Bearer ${key}` };

    const full = await fetch(url(smallId), { headers: auth });
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('{"ok":true}');

    const inline = await fetch(`${baseUrl}/files/${smallId}`, { headers: auth });
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe('{"ok":true}');

    const shareCreated = await fetch(`${baseUrl}/api/v1/files/${smallId}/shares`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(shareCreated.status, await shareCreated.clone().text()).toBe(201);
    const shareUrl = ((await shareCreated.json()) as { url: string }).url;
    const sharePath = new URL(shareUrl).pathname;
    for (let i = 0; i < 2; i++) {
      const landing = await fetch(`${baseUrl}${sharePath}`);
      expect(landing.status).toBe(200);
      await landing.text();
    }
    const sharedDownload = await fetch(`${baseUrl}${sharePath}/download`);
    expect(sharedDownload.status).toBe(200);
    expect(await sharedDownload.text()).toBe('{"ok":true}');

    const ranged = await fetch(url(bigId), { headers: { ...auth, range: 'bytes=0-31' } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(32);

    // Clients that hang up mid-transfer.
    for (let i = 0; i < 5; i++) {
      const ctrl = new AbortController();
      const res = await fetch(url(bigId), { headers: { ...auth, range: `bytes=${i * 1024}-` }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ctrl.abort();
      await reader.cancel().catch(() => {});
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => fetch(url(i % 2 ? smallId : bigId), { headers: auth }).then(async (r) => ({ status: r.status, len: (await r.arrayBuffer()).byteLength }))),
    );
    for (const [i, r] of results.entries()) {
      expect(r.status).toBe(200);
      expect(r.len).toBe(i % 2 ? 11 : big.length);
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(serverErrors.map((e) => (e as Error).message)).toEqual([]);

    await flushRequests();
    const tracked = await getPrisma().fileRequest.findMany({ where: { fileId: smallId }, select: { trafficType: true } });
    expect(tracked.filter((r) => r.trafficType === 'view')).toHaveLength(1);
    expect(tracked.filter((r) => r.trafficType === 'download')).toHaveLength(6);
    expect(tracked.filter((r) => r.trafficType === 'click')).toHaveLength(2);

    // Multipart uploads have no declared file size; enforce the provider quota
    // using the actual bytes received, and reject without persisting a file.
    const provider = await ensureDefaultProvider();
    const usage = await getPrisma().file.aggregate({ where: { storageProviderId: provider.id }, _sum: { size: true } });
    const countBefore = await getPrisma().file.count();
    try {
      await getPrisma().storageProvider.update({ where: { id: provider.id }, data: { capacity: (usage._sum.size ?? 0n) + 5n } });
      const tooLarge = new FormData();
      tooLarge.append('file', new Blob([Buffer.from('{"ok":true}')]), 'over-quota.json');
      const denied = await fetch(`${baseUrl}/api/v1/files`, { method: 'POST', headers: auth, body: tooLarge });
      expect(denied.status).toBe(413);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
      expect(await getPrisma().file.count()).toBe(countBefore);
    } finally {
      await getPrisma().storageProvider.update({ where: { id: provider.id }, data: { capacity: provider.capacity } });
    }
  });
});
