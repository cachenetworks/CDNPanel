import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { CdnApiError, CdnClient } from '@cachenetworks/cdnpanel-sdk';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { closeQueues } from '../src/lib/queue.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';

/** The generated TypeScript SDK against a real listening server. */

let app: FastifyInstance;
let cdn: CdnClient;
let baseUrl: string;

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(getPrisma());
  await ensureDefaultProvider();
  const founder = await getPrisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  const email = 'sdk-admin@example.com';
  await getPrisma().user.create({ data: { id: newId('user'), email, name: 'SDK', passwordHash: await hashPassword('Sdk-Passw0rd!xx'), roles: { create: [{ roleId: founder.id }] } } });
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Sdk-Passw0rd!xx' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrf_token };
  const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers, payload: { name: 'sdk', scopes: ['files:read', 'files:upload', 'files:update', 'files:delete', 'shares:write'] } });
  cdn = new CdnClient({ baseUrl, apiKey: key.json().key });
});

afterAll(async () => {
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
});

describe('TypeScript SDK', () => {
  it('identifies the key', async () => {
    const me = await cdn.identifyTheCaller();
    expect(me.type).toBe('api_key');
  });

  it('uploads small files directly and large files in chunks', async () => {
    const small = await cdn.uploadFile(new Blob(['hello sdk']), 'hello.txt', { visibility: 'PUBLIC', cacheTags: ['sdk:test'] });
    expect(small.cache_tags).toEqual(['sdk:test']);
    const big = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
    const chunked = await cdn.uploadFile(new Blob([big]), 'big.bin', { chunkThreshold: 1024, cacheTags: ['sdk:big'] });
    expect(chunked.size).toBe(big.length);
    expect(chunked.cache_tags).toEqual(['sdk:big']);
    const listed = await cdn.listAndSearchFiles({ query: { tag: 'sdk:big' } });
    expect(listed.data.map((f: { id: string }) => f.id)).toEqual([chunked.id]);
    const res = await cdn.downloadAFile(small.id);
    expect(await res.text()).toBe('hello sdk');
  });

  it('creates share links and maps errors to CdnApiError', async () => {
    const f = await cdn.uploadFile(new Blob(['x']), 'x.txt');
    const share = await cdn.createAShareLink(f.id, { body: { one_time: true } });
    expect(share.url).toMatch(/\/s\/[0-9A-Za-z]+$/);
    const err = await cdn.getAFile('file_00000000000000000000000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdnApiError);
    expect((err as CdnApiError).code).toBe('file_not_found');
    expect((err as CdnApiError).status).toBe(404);
  });
});
