import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { gfDiv, gfMul, gfPow2 } from './gf256.js';
import { RAID_META_SUFFIX, RaidStorageDriver, raidGeometry, raidUsableBytes, reconstructStripe, validateRaidLayout, type RaidLevel } from './raid.js';
import { StorageError, type ByteRange, type CapacityInfo, type ObjectInfo, type StorageDriver } from './types.js';

/** In-memory member that can be switched off (unreachable) or have its shards wiped (replaced disk). */
class MemDriver implements StorageDriver {
  readonly kind = 'LOCAL' as const;
  objects = new Map<string, Buffer>();
  down = false;
  constructor(public total = 1_000_000) {}
  private check() {
    if (this.down) throw new StorageError('node unreachable');
  }
  async put(key: string, body: Readable | Buffer): Promise<void> {
    this.check();
    const parts: Buffer[] = [];
    if (Buffer.isBuffer(body)) parts.push(body);
    else for await (const c of body) parts.push(Buffer.from(c as Buffer));
    this.check();
    this.objects.set(key, Buffer.concat(parts));
  }
  async get(key: string, range?: ByteRange): Promise<Readable> {
    this.check();
    const b = this.objects.get(key);
    if (!b) throw new StorageError('Object not found');
    const slice = range ? b.subarray(range.start, range.end + 1) : b;
    // Emit in odd-sized pieces to exercise re-chunking.
    const pieces: Buffer[] = [];
    for (let i = 0; i < slice.length; i += 1500) pieces.push(slice.subarray(i, i + 1500));
    return Readable.from(pieces);
  }
  async head(key: string): Promise<ObjectInfo | null> {
    this.check();
    const b = this.objects.get(key);
    return b ? { size: b.length } : null;
  }
  async delete(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
  }
  async copy(): Promise<void> {
    throw new Error('unused');
  }
  async healthCheck(): Promise<void> {
    this.check();
  }
  async capacity(): Promise<CapacityInfo> {
    this.check();
    return { total: this.total, available: this.total - [...this.objects.values()].reduce((a, b) => a + b.length, 0) };
  }
  async *listKeys(prefix = ''): AsyncIterable<string> {
    this.check();
    for (const k of this.objects.keys()) if (k.startsWith(prefix)) yield k;
  }
}

function pool(level: RaidLevel, n: number, chunkSize = 4096) {
  const mems = Array.from({ length: n }, () => new MemDriver());
  const driver = new RaidStorageDriver({ level, chunkSize, members: mems.map((d, i) => ({ id: `node${i}`, driver: d })) });
  return { mems, driver };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

const LAYOUTS: [RaidLevel, number][] = [
  ['RAID0', 1],
  ['RAID0', 3],
  ['RAID1', 2],
  ['RAID1', 3],
  ['RAID10', 4],
  ['RAID10', 6],
  ['RAID5', 3],
  ['RAID5', 5],
  ['RAID6', 4],
  ['RAID6', 6],
];

describe('GF(256)', () => {
  it('multiplies and divides consistently', () => {
    for (let a = 1; a < 256; a += 7) for (let b = 1; b < 256; b += 11) expect(gfDiv(gfMul(a, b), b)).toBe(a);
    expect(gfPow2(0)).toBe(1);
    expect(gfPow2(8)).toBe(0x1d);
  });
});

describe('RAID layout rules', () => {
  it('validates member counts', () => {
    expect(validateRaidLayout('RAID5', 2)).toMatch(/at least 3/);
    expect(validateRaidLayout('RAID6', 3)).toMatch(/at least 4/);
    expect(validateRaidLayout('RAID10', 5)).toMatch(/even/);
    expect(validateRaidLayout('RAID1', 2)).toBeNull();
  });
  it('computes usable capacity from the smallest member', () => {
    expect(raidUsableBytes('RAID0', [10, 20, 30])).toBe(30);
    expect(raidUsableBytes('RAID1', [10, 20])).toBe(10);
    expect(raidUsableBytes('RAID5', [10, 20, 30])).toBe(20);
    expect(raidUsableBytes('RAID6', [10, 10, 10, 10])).toBe(20);
    expect(raidUsableBytes('RAID10', [10, 10, 10, 10])).toBe(20);
    expect(raidGeometry('RAID6', 6).tolerance).toBe(2);
  });
  it('rebuilds any two lost data chunks with P+Q', () => {
    const d = 4;
    const data = Array.from({ length: d }, () => randomBytes(64));
    const P = Buffer.alloc(64);
    const Q = Buffer.alloc(64);
    data.forEach((b, j) => {
      for (let i = 0; i < 64; i++) {
        P[i]! ^= b[i]!;
        Q[i]! ^= gfMul(b[i]!, gfPow2(j));
      }
    });
    for (let x = 0; x < d; x++)
      for (let y = x + 1; y < d; y++) {
        const cols: (Buffer | null)[] = [...data, P, Q];
        cols[x] = null;
        cols[y] = null;
        expect(reconstructStripe(cols, d, 2)).toEqual(data);
      }
    // One data chunk plus P lost: Q alone recovers it.
    const cols: (Buffer | null)[] = [...data, null, Q];
    cols[2] = null;
    expect(reconstructStripe(cols, d, 2)).toEqual(data);
  });
});

describe.each(LAYOUTS)('%s over %i members', (level, n) => {
  const sizes = [0, 1, 4095, 4096, 12_345, 100_003];

  it('round-trips objects of many sizes and serves byte ranges', async () => {
    const { driver } = pool(level, n);
    for (const size of sizes) {
      const body = randomBytes(size);
      await driver.put(`obj/${size}`, Readable.from([body]), { contentType: 'application/octet-stream', size });
      expect(await readAll(await driver.get(`obj/${size}`))).toEqual(body);
      expect((await driver.head(`obj/${size}`))?.size).toBe(size);
      if (size > 10) {
        for (const [a, b] of [
          [0, 0],
          [5, size - 1],
          [Math.floor(size / 3), Math.floor((2 * size) / 3)],
          [size - 1, size - 1],
        ] as [number, number][]) {
          expect(await readAll(await driver.get(`obj/${size}`, { start: a, end: b }))).toEqual(body.subarray(a, b + 1));
        }
      }
    }
  });

  it('streams large objects written without a known size', async () => {
    const { driver } = pool(level, n, 8192);
    const body = randomBytes(300_000);
    const pieces: Buffer[] = [];
    for (let i = 0; i < body.length; i += 7777) pieces.push(body.subarray(i, i + 7777));
    await driver.put('big', Readable.from(pieces), { contentType: 'application/octet-stream' });
    expect(await readAll(await driver.get('big'))).toEqual(body);
  });

  const tolerance = raidGeometry(level, n).tolerance;
  if (tolerance > 0) {
    it(`keeps serving with ${tolerance} member(s) down, and repairs afterwards`, async () => {
      const { driver, mems } = pool(level, n);
      const body = randomBytes(50_000);
      await driver.put('a', body, { contentType: 'text/plain', size: body.length });
      // Lose `tolerance` members (for RAID10, one per mirror pair).
      const lost = level === 'RAID10' ? [0] : Array.from({ length: tolerance }, (_, i) => (i * 2 + 1) % n);
      for (const p of lost) mems[p]!.down = true;
      expect(await readAll(await driver.get('a'))).toEqual(body);
      expect(await readAll(await driver.get('a', { start: 1000, end: 40_000 }))).toEqual(body.subarray(1000, 40_001));

      // Degraded write while members are down.
      const body2 = randomBytes(33_333);
      await driver.put('b', body2, { contentType: 'text/plain', size: body2.length });
      expect(await readAll(await driver.get('b'))).toEqual(body2);

      // Members come back with blank disks (replaced hardware): repair restores full redundancy.
      for (const p of lost) {
        mems[p]!.down = false;
        mems[p]!.objects.clear();
      }
      const fresh = new RaidStorageDriver({ level, chunkSize: 4096, members: mems.map((d, i) => ({ id: `node${i}`, driver: d })) });
      expect(await fresh.repair('b')).toBe('repaired');
      expect(await fresh.repair('a', { verify: true })).toBe('repaired');
      expect(await fresh.repair('a', { verify: true })).toBe('ok');
      // Now a different set of members can fail and the data is still intact.
      const others = mems.map((_, i) => i).filter((i) => !lost.includes(i)).slice(0, tolerance);
      for (const p of others) mems[p]!.down = true;
      const after = new RaidStorageDriver({ level, chunkSize: 4096, members: mems.map((d, i) => ({ id: `node${i}`, driver: d })) });
      expect(await readAll(await after.get('a'))).toEqual(body);
      expect(await readAll(await after.get('b'))).toEqual(body2);
    });
  }

  it('refuses writes when more members are down than the level tolerates', async () => {
    const { driver, mems } = pool(level, n);
    for (let p = 0; p <= tolerance && p < n; p++) mems[p]!.down = true;
    await expect(driver.put('x', randomBytes(10_000), { contentType: 'a/b', size: 10_000 })).rejects.toThrow(StorageError);
  });

  it('lists, deletes and reports capacity', async () => {
    const { driver, mems } = pool(level, n);
    await driver.put('dir/one', randomBytes(10), { contentType: 'a/b', size: 10 });
    await driver.put('dir/two', randomBytes(10), { contentType: 'a/b', size: 10 });
    const keys: string[] = [];
    for await (const k of driver.listKeys('dir/')) keys.push(k);
    expect(keys.sort()).toEqual(['dir/one', 'dir/two']);
    await driver.delete('dir/one');
    expect(await driver.head('dir/one')).toBeNull();
    expect(mems.every((m) => !m.objects.has('dir/one') && !m.objects.has('dir/one' + RAID_META_SUFFIX))).toBe(true);
    const cap = await driver.capacity();
    expect(cap.total).toBe(1_000_000 * raidGeometry(level, n).data);
  });
});

describe('replaced members', () => {
  it('treats shards written for a different member id as stale and rebuilds them', async () => {
    const { driver, mems } = pool('RAID5', 3);
    const body = randomBytes(20_000);
    await driver.put('k', body, { contentType: 'a/b', size: body.length });
    const replacement = new MemDriver();
    const swapped = new RaidStorageDriver({ level: 'RAID5', chunkSize: 4096, members: [{ id: 'node0', driver: mems[0]! }, { id: 'node9', driver: replacement }, { id: 'node2', driver: mems[2]! }] });
    expect(await readAll(await swapped.get('k'))).toEqual(body);
    expect(await swapped.repair('k')).toBe('repaired');
    mems[0]!.down = true;
    expect(await readAll(await swapped.get('k'))).toEqual(body);
  });
});

describe('expanding a pool', () => {
  const cases: [RaidLevel, number, RaidLevel, number][] = [
    ['RAID0', 1, 'RAID0', 2],
    ['RAID0', 1, 'RAID1', 2],
    ['RAID1', 2, 'RAID5', 3],
    ['RAID5', 3, 'RAID5', 4],
    ['RAID5', 4, 'RAID6', 5],
    ['RAID10', 4, 'RAID10', 6],
  ];
  it.each(cases)('%s × %i → %s × %i keeps old objects readable and reshapes them', async (fromLevel, fromN, toLevel, toN) => {
    const mems = Array.from({ length: toN }, () => new MemDriver());
    const member = (i: number) => ({ id: `node${i}`, driver: mems[i]! });
    const before = new RaidStorageDriver({ level: fromLevel, chunkSize: 4096, members: mems.slice(0, fromN).map((_, i) => member(i)) });
    const objects = new Map<string, Buffer>();
    for (const size of [0, 5, 9000, 70_001]) {
      const body = randomBytes(size);
      objects.set(`objects/o${size}`, body);
      await before.put(`objects/o${size}`, body, { contentType: 'application/octet-stream', size });
    }

    const after = new RaidStorageDriver({ level: toLevel, chunkSize: 4096, members: mems.map((_, i) => member(i)) });
    // Readable straight away, on the old layout.
    for (const [k, b] of objects) expect(await readAll(await after.get(k))).toEqual(b);
    // New writes use the new layout immediately.
    const fresh = randomBytes(20_000);
    await after.put('objects/new', fresh, { contentType: 'a/b', size: fresh.length });
    expect((await after.readManifest('objects/new'))!.members).toHaveLength(toN);

    for (const k of objects.keys()) expect(await after.repair(k)).toBe('reshaped');
    for (const k of objects.keys()) expect(await after.repair(k)).toBe('ok');
    for (const [k, b] of objects) {
      const m = (await after.readManifest(k))!;
      expect(m.level).toBe(toLevel);
      expect(m.members).toHaveLength(toN);
      expect(await readAll(await after.get(k))).toEqual(b);
      expect(await readAll(await after.get(k, { start: 0, end: Math.max(0, b.length - 1) }))).toEqual(b);
    }
    // Old shards are gone: only the reshaped shard key and the manifest remain per object.
    const keys = new Set(mems.flatMap((d) => [...d.objects.keys()]));
    expect([...keys].filter((k) => k.startsWith('objects/o') && !k.includes('.r') && !k.endsWith(RAID_META_SUFFIX))).toEqual([]);

    // The new layout's redundancy really holds.
    const tol = raidGeometry(toLevel, toN).tolerance;
    if (tol > 0) {
      mems[toN - 1]!.down = true;
      const degraded = new RaidStorageDriver({ level: toLevel, chunkSize: 4096, members: mems.map((_, i) => member(i)) });
      for (const [k, b] of objects) expect(await readAll(await degraded.get(k))).toEqual(b);
      mems[toN - 1]!.down = false;
    }

    // Deleting a reshaped object removes its shards everywhere; overwriting cleans the old shard key.
    await after.delete('objects/o5');
    expect([...new Set(mems.flatMap((d) => [...d.objects.keys()]))].some((k) => k.startsWith('objects/o5'))).toBe(false);
    const again = randomBytes(1234);
    await after.put('objects/o9000', again, { contentType: 'a/b', size: again.length });
    expect(await readAll(await after.get('objects/o9000'))).toEqual(again);
    expect([...new Set(mems.flatMap((d) => [...d.objects.keys()]))].filter((k) => k.startsWith('objects/o9000.r') && !k.endsWith(RAID_META_SUFFIX))).toEqual([]);
  });

  it('refuses to read objects spread over more members than the pool has', async () => {
    const mems = [new MemDriver(), new MemDriver(), new MemDriver()];
    const wide = new RaidStorageDriver({ level: 'RAID5', chunkSize: 4096, members: mems.map((d, i) => ({ id: `n${i}`, driver: d })) });
    await wide.put('k', randomBytes(100), { contentType: 'a/b', size: 100 });
    const narrow = new RaidStorageDriver({ level: 'RAID1', chunkSize: 4096, members: mems.slice(0, 2).map((d, i) => ({ id: `n${i}`, driver: d })) });
    await expect(narrow.get('k')).rejects.toThrow(/cannot shrink/);
  });
});
