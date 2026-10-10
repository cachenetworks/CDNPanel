import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { newId } from '@cdn/shared';
import { buildApp } from '../src/app.js';
import { createNodeAgent } from '../src/node-agent.js';
import { hashPassword } from '../src/lib/password.js';
import { closeQueues } from '../src/lib/queue.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { flushRequests } from '../src/lib/requestLog.js';
import { ensureDefaultProvider } from '../src/lib/storageRegistry.js';
import { checkNodes, runPoolRepair } from '../src/services/storageNodes.js';
import { clusterStorage } from '../src/services/storageCapacity.js';

/** Storage nodes + RAID pools through the HTTP API, against real node agents. */

const ADMIN = { email: 'nodes-admin@example.com', password: 'Nodes-Passw0rd!x' };
const TOKEN = 'integration-node-token-0123456789abcdefghij';
let app: FastifyInstance;
let staff: Record<string, string>;
let key: string;
const agents: { server: http.Server; url: string; dir: string }[] = [];

async function startAgent(i: number) {
  const dir = path.resolve('.test-data', 'nodes', `agent-${i}-${Date.now()}`);
  const server = createNodeAgent({ token: TOKEN, dataPath: dir, name: `agent-${i}` });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
  agents.push(a);
  return a;
}

async function stopAgent(a: { server: http.Server }) {
  const closed = new Promise((r) => a.server.close(r));
  a.server.closeAllConnections();
  await closed;
}

function multipart(name: string, content: Buffer) {
  const boundary = `----nodes${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${key}` } };
}

async function uploadFile(name: string, content: Buffer): Promise<string> {
  const mp = multipart(name, content);
  const res = await app.inject({ method: 'POST', url: '/api/v1/files', headers: mp.headers, payload: mp.payload });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

async function download(id: string, range?: string): Promise<Buffer> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/files/${id}/download`, headers: { authorization: `Bearer ${key}`, ...(range ? { range } : {}) } });
  expect([200, 206], res.body.slice(0, 300)).toContain(res.statusCode);
  return res.rawPayload;
}

beforeAll(async () => {
  await getRedis().flushdb();
  await seedDatabase(getPrisma());
  await ensureDefaultProvider();
  const founder = await getPrisma().role.findUniqueOrThrow({ where: { name: 'Founder' } });
  await getPrisma().user.create({ data: { id: newId('user'), email: ADMIN.email, name: 'Nodes', passwordHash: await hashPassword(ADMIN.password), roles: { create: [{ roleId: founder.id }] } } });
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
  const setCookie = login.headers['set-cookie'];
  staff = { cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!, 'x-csrf-token': login.json().csrf_token };
  await app.inject({ method: 'POST', url: '/api/v1/auth/reauth', headers: staff, payload: { password: ADMIN.password } });
  const k = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: staff, payload: { name: 'nodes', scopes: ['files:read', 'files:upload', 'files:delete'] } });
  key = k.json().key;
  for (let i = 0; i < 4; i++) await startAgent(i);
});

afterAll(async () => {
  // Leave the environment provider as the default for suites that run afterwards.
  const prisma = getPrisma();
  const env = await prisma.storageProvider.findFirst({ where: { name: 'Primary (environment)' } });
  if (env) {
    await prisma.storageProvider.updateMany({ data: { isDefault: false } });
    await prisma.storageProvider.update({ where: { id: env.id }, data: { isDefault: true } });
  }
  await Promise.all(agents.map((a) => stopAgent(a).catch(() => undefined)));
  await app?.close();
  await flushRequests();
  await closeQueues();
  await closeRedis();
  await disconnectPrisma();
  await fs.rm(path.resolve('.test-data', 'nodes'), { recursive: true, force: true });
});

describe('storage nodes and RAID pools', () => {
  const nodeIds: string[] = [];
  let poolId: string;
  let providerId: string;
  const bodies = new Map<string, Buffer>();

  it('registers remote nodes only when they answer with the right token', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: 'bad', url: agents[0]!.url, token: 'x'.repeat(40) } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/rejected the token/);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: `node-${i}`, url: agents[i]!.url, token: TOKEN, region: 'au' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().status).toBe('online');
      expect(res.json().total_bytes).toBeGreaterThan(0);
      expect(JSON.stringify(res.json())).not.toContain(TOKEN);
      nodeIds.push(res.json().id);
    }
    const dup = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: 'dup', url: agents[0]!.url, token: TOKEN } });
    expect(dup.statusCode).toBe(409);
    const local = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: 'escape', kind: 'LOCAL', path: '../../etc' } });
    expect(local.statusCode).toBe(422);
  });

  it('lists nodes outside a pool without counting them as usable space', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: staff });
    expect(res.statusCode, res.body).toBe(200);
    const cluster = res.json().cluster;
    const nodes = cluster.servers.filter((s: { role: string }) => s.role === 'node');
    expect(nodes.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['node-0', 'node-1', 'node-2']));
    expect(nodes.every((s: { counted: boolean }) => !s.counted)).toBe(true);
    const counted = cluster.servers.filter((s: { counted: boolean }) => s.counted);
    expect(cluster.total).toBe(counted.reduce((a: number, s: { total: number }) => a + s.total, 0));
    expect(cluster.unassigned_nodes).toBe(nodes.length);
    const overview = await app.inject({ method: 'GET', url: '/api/v1/dashboard/overview', headers: staff });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().stats.cluster_total).toBe(cluster.total);
  });

  it('counts cloud buckets by their quota and measured usage', async () => {
    const prisma = getPrisma();
    const before = await clusterStorage();
    const id = newId('storageProvider');
    const noQuota = newId('storageProvider');
    const GB = 1024 ** 3;
    await prisma.storageProvider.createMany({
      data: [
        { id, name: 'cloud-b2', kind: 'B2', configEnc: 'x', capacity: BigInt(10 * GB), healthStatus: 'healthy', bucketUsedBytes: BigInt(3 * GB), bucketObjectCount: 42, usageCheckedAt: new Date() },
        { id: noQuota, name: 'cloud-r2', kind: 'R2', configEnc: 'x', healthStatus: 'healthy', bucketUsedBytes: BigInt(GB), bucketObjectCount: 7 },
      ],
    });
    try {
      const after = await clusterStorage();
      const b2 = after.servers.find((x) => x.name === 'cloud-b2')!;
      expect(b2).toMatchObject({ role: 'cloud', kind: 'B2', status: 'online', total: 10 * GB, used: 3 * GB, free: 7 * GB, objects: 42 });
      const r2 = after.servers.find((x) => x.name === 'cloud-r2')!;
      expect(r2).toMatchObject({ role: 'cloud', total: null, free: null, used: GB });
      expect(after.cloud_count).toBe(before.cloud_count + 2);
      // A bucket without a quota has no size to add; one with a quota adds its quota.
      expect(after.total - before.total).toBe(10 * GB);
      expect(after.free - before.free).toBe(7 * GB);
    } finally {
      await prisma.storageProvider.deleteMany({ where: { id: { in: [id, noQuota] } } });
    }
  });

  it('validates RAID layouts', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/pools', headers: staff, payload: { name: 'tiny', level: 'RAID5', node_ids: nodeIds.slice(0, 2) } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/at least 3/);
  });

  it('creates a RAID5 pool that stores files like any provider', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/pools', headers: staff, payload: { name: 'raid5-pool', level: 'RAID5', node_ids: nodeIds, chunk_size_kb: 64 } });
    expect(res.statusCode, res.body).toBe(201);
    const pool = res.json();
    poolId = pool.id;
    providerId = pool.provider_id;
    expect(pool.status).toBe('healthy');
    expect(pool.fault_tolerance).toBe(1);
    expect(pool.data_nodes).toBe(2);
    expect(pool.usable_bytes).toBeGreaterThan(0);
    expect(pool.members.map((m: { node: { id: string } }) => m.node.id)).toEqual(nodeIds);

    const totals = await clusterStorage();
    const entry = totals.servers.find((x) => x.role === 'pool' && x.name === 'raid5-pool')!;
    expect(entry).toMatchObject({ counted: true, level: 'RAID5', nodes: ['node-0', 'node-1', 'node-2'] });
    expect(entry.total).toBe(pool.usable_bytes);
    expect(entry.raw_total).toBeGreaterThan(entry.total!);
    expect(totals.servers.filter((x) => x.role === 'node').map((x) => x.name)).not.toEqual(expect.arrayContaining(['node-0']));
    const taken = await app.inject({ method: 'POST', url: '/api/v1/storage/pools', headers: staff, payload: { name: 'again', level: 'RAID1', node_ids: nodeIds.slice(0, 2) } });
    expect(taken.statusCode).toBe(409);

    const def = await app.inject({ method: 'PATCH', url: `/api/v1/storage/providers/${providerId}`, headers: staff, payload: { is_default: true } });
    expect(def.statusCode, def.body).toBe(200);

    for (const size of [10, 70_000, 1_000_003]) {
      const body = randomBytes(size);
      const id = await uploadFile(`f${size}.bin`, body);
      bodies.set(id, body);
      expect(await download(id)).toEqual(body);
      const file = await getPrisma().file.findUniqueOrThrow({ where: { id } });
      expect(file.storageProviderId).toBe(providerId);
    }
    // Shards really are spread over the nodes (no node holds a full copy of the big file).
    const big = [...bodies.entries()].find(([, b]) => b.length > 1_000_000)!;
    const file = await getPrisma().file.findUniqueOrThrow({ where: { id: big[0] } });
    for (const a of agents.slice(0, 3)) {
      const st = await fs.stat(path.join(a.dir, file.storageKey));
      expect(st.size).toBeLessThan(big[1].length);
      expect(st.size).toBeGreaterThan(big[1].length / 2 - 70_000);
    }
  });

  it('keeps serving when a node goes down, then rebuilds onto a replacement node', async () => {
    await stopAgent(agents[1]!);
    expect((await checkNodes()).changed).toBeGreaterThanOrEqual(1);
    const pool = (await app.inject({ method: 'GET', url: `/api/v1/storage/pools/${poolId}`, headers: staff })).json();
    expect(pool.status).toBe('degraded');
    expect(pool.members[1].node.status).toBe('offline');

    for (const [id, body] of bodies) expect(await download(id)).toEqual(body);
    expect(await download([...bodies.keys()][2]!, 'bytes=100-200099')).toEqual(bodies.get([...bodies.keys()][2]!)!.subarray(100, 200_100));

    // Degraded write while node-1 is away.
    const late = randomBytes(150_000);
    const lateId = await uploadFile('late.bin', late);
    bodies.set(lateId, late);
    expect(await download(lateId)).toEqual(late);

    // Swap in a brand-new node for slot 2 and rebuild it.
    const add = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: 'node-new', url: agents[3]!.url, token: TOKEN } });
    expect(add.statusCode, add.body).toBe(201);
    const replace = await app.inject({ method: 'POST', url: `/api/v1/storage/pools/${poolId}/members/1/replace`, headers: staff, payload: { node_id: add.json().id } });
    expect(replace.statusCode, replace.body).toBe(200);
    expect(replace.json().status).toBe('healthy');
    const state = await runPoolRepair(poolId, { positions: [1] });
    expect(state.failed).toBe(0);
    expect(state.repaired).toBe(bodies.size);

    // Now lose a different original node: data must still be complete thanks to the rebuilt slot.
    await stopAgent(agents[0]!);
    await checkNodes();
    for (const [id, body] of bodies) expect(await download(id)).toEqual(body);

    const removeMember = await app.inject({ method: 'DELETE', url: `/api/v1/storage/nodes/${nodeIds[2]}`, headers: staff });
    expect(removeMember.statusCode).toBe(409);
    const released = await app.inject({ method: 'DELETE', url: `/api/v1/storage/nodes/${nodeIds[1]}`, headers: staff });
    expect(released.statusCode).toBe(204);
  });

  it('grows a one-node pool into RAID 1 and reshapes existing files onto it', async () => {
    const a = await startAgent(10);
    const b = await startAgent(11);
    const ids: string[] = [];
    for (const [i, ag] of [a, b].entries()) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/storage/nodes', headers: staff, payload: { name: `grow-${i}`, url: ag.url, token: TOKEN } });
      expect(res.statusCode, res.body).toBe(201);
      ids.push(res.json().id);
    }
    const created = await app.inject({ method: 'POST', url: '/api/v1/storage/pools', headers: staff, payload: { name: 'grow-pool', level: 'RAID0', node_ids: [ids[0]], chunk_size_kb: 64 } });
    expect(created.statusCode, created.body).toBe(201);
    const pool = created.json();
    await app.inject({ method: 'PATCH', url: `/api/v1/storage/providers/${pool.provider_id}`, headers: staff, payload: { is_default: true } });
    const files = new Map<string, Buffer>();
    for (const size of [100, 300_000]) {
      const body = randomBytes(size);
      files.set(await uploadFile(`grow-${size}.bin`, body), body);
    }

    const bad = await app.inject({ method: 'POST', url: `/api/v1/storage/pools/${pool.id}/members`, headers: staff, payload: { node_ids: [ids[1]], level: 'RAID5' } });
    expect(bad.statusCode).toBe(422);
    const grown = await app.inject({ method: 'POST', url: `/api/v1/storage/pools/${pool.id}/members`, headers: staff, payload: { node_ids: [ids[1]], level: 'RAID1' } });
    expect(grown.statusCode, grown.body).toBe(200);
    expect(grown.json().level).toBe('RAID1');
    expect(grown.json().fault_tolerance).toBe(1);
    expect(grown.json().members).toHaveLength(2);
    // Still readable before the reshape runs.
    for (const [id, body] of files) expect(await download(id)).toEqual(body);

    const state = await runPoolRepair(pool.id, { reason: 'test' });
    expect(state.reshaped).toBe(files.size);
    expect(state.failed).toBe(0);

    // The original node can now go away: RAID 1 keeps every file.
    await stopAgent(a);
    await checkNodes();
    for (const [id, body] of files) expect(await download(id)).toEqual(body);
  });

  it('refuses to delete a pool that still holds files', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/storage/pools/${poolId}`, headers: staff });
    expect(res.statusCode).toBe(409);
    const generic = await app.inject({ method: 'DELETE', url: `/api/v1/storage/providers/${providerId}`, headers: staff });
    expect(generic.statusCode).toBe(409);
  });
});
