import fs from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeStorageDriver, RaidStorageDriver, StorageError } from '@cdn/storage';
import { createNodeAgent } from './node-agent.js';

const TOKEN = 'test-node-token-0123456789-abcdefghijklmnop';

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

describe('storage node agent', () => {
  const servers: http.Server[] = [];
  const urls: string[] = [];
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-node-'));
    for (let i = 0; i < 3; i++) {
      const server = createNodeAgent({ token: TOKEN, dataPath: path.join(root, `n${i}`), name: `node-${i}` });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      servers.push(server);
      urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses weak tokens and wrong credentials', async () => {
    expect(() => createNodeAgent({ token: 'short', dataPath: root })).toThrow(/32 characters/);
    const bad = new NodeStorageDriver({ url: urls[0]!, token: 'x'.repeat(40) });
    await expect(bad.status()).rejects.toThrow(/rejected the token/);
    const res = await fetch(`${urls[0]}/v1/objects/a`, { headers: { authorization: `Bearer ${TOKEN}x` } });
    expect(res.status).toBe(401);
  });

  it('stores, ranges, lists, copies and deletes objects', async () => {
    const node = new NodeStorageDriver({ url: urls[0]!, token: TOKEN });
    const body = randomBytes(200_000);
    await node.put('objects/ab/cd/file-1', Readable.from([body]), { contentType: 'application/octet-stream', size: body.length });
    expect(await readAll(await node.get('objects/ab/cd/file-1'))).toEqual(body);
    expect(await readAll(await node.get('objects/ab/cd/file-1', { start: 10, end: 99 }))).toEqual(body.subarray(10, 100));
    expect((await node.head('objects/ab/cd/file-1'))?.size).toBe(body.length);
    await node.copy('objects/ab/cd/file-1', 'objects/ab/cd/file-2');
    const keys: string[] = [];
    for await (const k of node.listKeys('objects/')) keys.push(k);
    expect(keys.sort()).toEqual(['objects/ab/cd/file-1', 'objects/ab/cd/file-2']);
    await node.delete('objects/ab/cd/file-1');
    expect(await node.head('objects/ab/cd/file-1')).toBeNull();
    await expect(node.get('objects/missing')).rejects.toThrow(/not found/i);
    const status = await node.status();
    expect(status.node_name).toBe('node-0');
    expect(status.total).toBeGreaterThan(0);
    await node.healthCheck();
  });

  it('rejects path traversal', async () => {
    for (const p of ['/v1/objects/..%2F..%2Fetc%2Fpasswd', '/v1/objects/a/../../x']) {
      const res = await fetch(urls[0] + p, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect([400, 404]).toContain(res.status);
    }
  });

  it('runs a RAID5 pool across three nodes and survives one going offline', { timeout: 30_000 }, async () => {
    const members = urls.map((url, i) => ({ id: `snd_${i}`, driver: new NodeStorageDriver({ url, token: TOKEN, timeoutMs: 2000 }) }));
    const pool = new RaidStorageDriver({ level: 'RAID5', chunkSize: 64 * 1024, members });
    const body = randomBytes(1_234_567);
    await pool.put('objects/pool/file', Readable.from([body]), { contentType: 'video/mp4', size: body.length });
    expect(await readAll(await pool.get('objects/pool/file'))).toEqual(body);

    // Take node 1 offline: reads reconstruct from parity.
    const closed = new Promise((r) => servers[1]!.close(r));
    servers[1]!.closeAllConnections();
    await closed;
    expect(await readAll(await pool.get('objects/pool/file', { start: 500_000, end: 900_000 }))).toEqual(body.subarray(500_000, 900_001));
    await expect(pool.healthCheck()).resolves.toBeUndefined();
    const cap = await pool.capacity();
    expect(cap.total).toBeGreaterThan(0);
    await expect(new RaidStorageDriver({ level: 'RAID0', members }).get('objects/pool/file')).rejects.toBeInstanceOf(StorageError);
  });
});
