import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { gfDiv, gfPow2, mulBuf, mulXorInto, xorInto } from './gf256.js';
import { StorageError, type ByteRange, type CapacityInfo, type ObjectInfo, type PutOptions, type StorageDriver } from './types.js';

/**
 * Software RAID across storage drivers (normally storage nodes).
 *
 * Every object is cut into stripes. A stripe holds `data` chunks of user bytes plus `parity` chunks;
 * each member stores exactly one chunk per stripe, appended to a per-object shard stored under the
 * object's own key, so a member's shard is `stripes × chunk` bytes long. A small JSON manifest
 * (`<key>.raidmeta`) on every member records size, chunk size, layout and which members still need
 * a rebuild.
 *
 *   RAID0   striping, no redundancy               usable = n × smallest
 *   RAID1   n-way mirror                          usable = 1 × smallest, survives n−1 failures
 *   RAID10  striped mirrors (pairs)               usable = n/2 × smallest, survives 1 failure (1 per pair)
 *   RAID5   striping + rotating XOR parity        usable = (n−1) × smallest, survives 1 failure
 *   RAID6   striping + rotating P/Q parity (RS)   usable = (n−2) × smallest, survives 2 failures
 */

export type RaidLevel = 'RAID0' | 'RAID1' | 'RAID5' | 'RAID6' | 'RAID10';
export const RAID_LEVELS: RaidLevel[] = ['RAID0', 'RAID1', 'RAID5', 'RAID6', 'RAID10'];

export interface RaidMember {
  /** Stable member identity (the storage node id). Recorded in manifests to detect replaced members. */
  id: string;
  driver: StorageDriver;
  /** Known to be offline: skipped for writes and reads instead of waiting for timeouts. */
  offline?: boolean;
}

export interface RaidConfig {
  level: RaidLevel;
  members: RaidMember[];
  /** Maximum chunk size in bytes (default 1 MiB). Small objects use smaller chunks. */
  chunkSize?: number;
}

export interface RaidGeometry {
  /** Data chunks per stripe. */
  data: number;
  /** Parity chunks per stripe. */
  parity: number;
  /** Members that can be lost without losing data. */
  tolerance: number;
  minMembers: number;
}

export interface RaidManifest {
  v: 1;
  level: RaidLevel;
  /** Member ids by position at the time the shards were written. */
  members: string[];
  chunk: number;
  size: number;
  contentType: string;
  /** Positions whose shard was not written (degraded write) and need a rebuild. */
  missing: number[];
  updatedAt: string;
  /**
   * Key the shards are stored under on each member (default: the object key). A reshape writes the
   * new layout under a fresh shard key and only then switches the manifest over, so an interrupted
   * reshape never damages the existing copy.
   */
  shardKey?: string;
}

/** The RAID layout an object was written with (it can differ from the pool's after an expansion). */
export interface RaidLayout {
  level: RaidLevel;
  /** Number of members the object is spread over: positions 0..n-1 of the pool. */
  n: number;
  geometry: RaidGeometry;
}

export function raidLayout(level: RaidLevel, n: number): RaidLayout {
  return { level, n, geometry: raidGeometry(level, n) };
}

export type RepairResult = 'ok' | 'repaired' | 'reshaped' | 'partial' | 'missing';

export const RAID_META_SUFFIX = '.raidmeta';
const MIN_CHUNK = 4096;

export function raidGeometry(level: RaidLevel, n: number): RaidGeometry {
  switch (level) {
    case 'RAID0':
      return { data: n, parity: 0, tolerance: 0, minMembers: 1 };
    case 'RAID1':
      return { data: 1, parity: 0, tolerance: Math.max(0, n - 1), minMembers: 2 };
    case 'RAID10':
      return { data: Math.floor(n / 2), parity: 0, tolerance: 1, minMembers: 4 };
    case 'RAID5':
      return { data: n - 1, parity: 1, tolerance: 1, minMembers: 3 };
    case 'RAID6':
      return { data: n - 2, parity: 2, tolerance: 2, minMembers: 4 };
  }
}

/** Returns a human-readable problem with the member count for a level, or null when valid. */
export function validateRaidLayout(level: RaidLevel, n: number): string | null {
  const g = raidGeometry(level, n);
  if (n < g.minMembers) return `${level} needs at least ${g.minMembers} node${g.minMembers === 1 ? '' : 's'}.`;
  if (level === 'RAID10' && n % 2 !== 0) return 'RAID10 needs an even number of nodes (mirrored pairs).';
  if (n > 32) return 'A pool can have at most 32 nodes.';
  return null;
}

/** Usable bytes of a pool, limited by its smallest member like hardware RAID. */
export function raidUsableBytes(level: RaidLevel, memberBytes: number[]): number {
  if (!memberBytes.length) return 0;
  return Math.min(...memberBytes) * raidGeometry(level, memberBytes.length).data;
}

/** Members (positions) holding column `col` of stripe `s`. Columns: data 0..d−1, then P, then Q. */
export function columnMembers(level: RaidLevel, n: number, s: number, col: number): number[] {
  switch (level) {
    case 'RAID0':
      return [col];
    case 'RAID1':
      return Array.from({ length: n }, (_, i) => i);
    case 'RAID10':
      return [2 * col, 2 * col + 1];
    case 'RAID5':
    case 'RAID6':
      // Parity rotates across members stripe by stripe, so no single node is a parity hot spot.
      return [(col + s) % n];
  }
}

/** Rebuilds the data chunks of one stripe from what was read (null = unavailable). */
export function reconstructStripe(cols: (Buffer | null)[], data: number, parity: number): Buffer[] {
  const out = cols.slice(0, data);
  const lost = out.flatMap((b, j) => (b ? [] : [j]));
  if (!lost.length) return out as Buffer[];
  const P = parity >= 1 ? cols[data] : null;
  const Q = parity >= 2 ? cols[data + 1] : null;
  if (lost.length === 1) {
    const x = lost[0]!;
    if (P) {
      const r = Buffer.from(P);
      out.forEach((b, j) => j !== x && xorInto(r, b!));
      out[x] = r;
      return out as Buffer[];
    }
    if (Q) {
      const r = Buffer.from(Q);
      out.forEach((b, j) => j !== x && mulXorInto(r, b!, gfPow2(j)));
      out[x] = mulBuf(r, gfDiv(1, gfPow2(x)));
      return out as Buffer[];
    }
  }
  if (lost.length === 2 && P && Q) {
    const [x, y] = lost as [number, number];
    const pxy = Buffer.from(P);
    const qxy = Buffer.from(Q);
    out.forEach((b, j) => {
      if (j === x || j === y) return;
      xorInto(pxy, b!);
      mulXorInto(qxy, b!, gfPow2(j));
    });
    // pxy = Dx ⊕ Dy, qxy = gˣDx ⊕ gʸDy  ⇒  Dx = (qxy ⊕ gʸ·pxy) / (gˣ ⊕ gʸ)
    const gx = gfPow2(x);
    const gy = gfPow2(y);
    const t = Buffer.from(qxy);
    mulXorInto(t, pxy, gy);
    const dx = mulBuf(t, gfDiv(1, gx ^ gy));
    const dy = Buffer.from(pxy);
    xorInto(dy, dx);
    out[x] = dx;
    out[y] = dy;
    return out as Buffer[];
  }
  throw new StorageError(`Too many pool members unavailable to rebuild the data (${lost.length} data chunks lost)`);
}

/** Reads exact-sized pieces from a stream. */
class ChunkReader {
  private readonly it: AsyncIterator<Buffer>;
  /** Pending pieces; joined once per read instead of once per network packet. */
  private pieces: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(private readonly stream: Readable) {
    this.it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Up to `n` bytes; fewer only at end of stream. */
  async readUpTo(n: number): Promise<Buffer> {
    while (this.buffered < n && !this.ended) {
      const r = await this.it.next();
      if (r.done) this.ended = true;
      else {
        const v = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
        this.pieces.push(v);
        this.buffered += v.length;
      }
    }
    const all = this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces, this.buffered);
    const out = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(out.length);
    this.pieces = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  async read(n: number): Promise<Buffer> {
    const b = await this.readUpTo(n);
    if (b.length !== n) throw new StorageError('Shard ended early');
    return b;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

export class RaidStorageDriver implements StorageDriver {
  readonly kind = 'POOL' as const;
  readonly level: RaidLevel;
  readonly geometry: RaidGeometry;
  /** The pool's current layout: used for every new write. */
  readonly layout: RaidLayout;
  private readonly members: RaidMember[];
  private readonly maxChunk: number;
  /** Positions that failed recently (epoch ms until which they are skipped). */
  private readonly downUntil = new Map<number, number>();

  constructor(config: RaidConfig) {
    const problem = validateRaidLayout(config.level, config.members.length);
    if (problem) throw new StorageError(problem);
    this.level = config.level;
    this.members = config.members;
    this.geometry = raidGeometry(config.level, config.members.length);
    this.layout = { level: this.level, n: config.members.length, geometry: this.geometry };
    const chunk = config.chunkSize ?? 1024 * 1024;
    if (chunk < MIN_CHUNK || chunk % MIN_CHUNK !== 0) throw new StorageError(`Chunk size must be a multiple of ${MIN_CHUNK} bytes`);
    this.maxChunk = chunk;
  }

  get size(): number {
    return this.members.length;
  }

  private isDown(p: number): boolean {
    if (this.members[p]!.offline) return true;
    const until = this.downUntil.get(p);
    return until !== undefined && until > Date.now();
  }

  private markDown(p: number): void {
    this.downUntil.set(p, Date.now() + 30_000);
  }

  /** Member positions, reachable ones first. */
  private preferredOrder(): number[] {
    const all = this.members.map((_, i) => i);
    return [...all.filter((p) => !this.isDown(p)), ...all.filter((p) => this.isDown(p))];
  }

  chunkFor(size?: number, layout: RaidLayout = this.layout): number {
    if (size === undefined) return this.maxChunk;
    const per = Math.ceil(Math.max(size, 1) / layout.geometry.data);
    const rounded = Math.ceil(per / MIN_CHUNK) * MIN_CHUNK;
    return Math.min(this.maxChunk, Math.max(MIN_CHUNK, rounded));
  }

  /** Bytes each member stores for an object of `size` bytes with `chunk`-sized chunks. */
  shardLength(size: number, chunk: number, layout: RaidLayout = this.layout): number {
    return Math.ceil(size / (chunk * layout.geometry.data)) * chunk;
  }

  /** The layout recorded in a manifest. Pools only grow by appending members, so position p is still member p. */
  layoutOf(m: RaidManifest): RaidLayout {
    if (m.members.length > this.members.length) {
      throw new StorageError(`Object is spread over ${m.members.length} members but the pool now has ${this.members.length}; pools cannot shrink`);
    }
    return raidLayout(m.level, m.members.length);
  }

  private sameLayout(a: RaidLayout, b: RaidLayout): boolean {
    return a.level === b.level && a.n === b.n;
  }

  // ---------------------------------------------------------------------------------- writing

  /** Encodes `body` into shards written to `targets` (positions). Returns the size and failed positions. */
  private async writeShards(key: string, body: Readable | Buffer, chunk: number, targets: number[], layout: RaidLayout = this.layout): Promise<{ size: number; failed: number[] }> {
    const { data, parity } = layout.geometry;
    const { n, level } = layout;
    type Sink = { pt: PassThrough; done: Promise<void>; failed: boolean; err?: unknown };
    const sinks = new Map<number, Sink>();
    for (const p of targets) {
      const pt = new PassThrough();
      const sink: Sink = { pt, failed: false, done: Promise.resolve() };
      sink.done = this.members[p]!.driver.put(key, pt, { contentType: 'application/octet-stream' }).catch((err: unknown) => {
        sink.failed = true;
        sink.err = err;
        this.markDown(p);
        pt.destroy();
      });
      sinks.set(p, sink);
    }
    const write = async (p: number, buf: Buffer) => {
      const sink = sinks.get(p);
      if (!sink || sink.failed) return;
      if (!sink.pt.write(buf)) await Promise.race([once(sink.pt, 'drain').catch(() => undefined), sink.done, once(sink.pt, 'close')]);
    };

    const reader = new ChunkReader(Buffer.isBuffer(body) ? Readable.from([body]) : body);
    const stripeBytes = chunk * data;
    let size = 0;
    try {
      for (let s = 0; ; s++) {
        const bytes = await reader.readUpTo(stripeBytes);
        if (!bytes.length) break;
        size += bytes.length;
        const padded = bytes.length < stripeBytes ? Buffer.concat([bytes, Buffer.alloc(stripeBytes - bytes.length)]) : bytes;
        const cols: Buffer[] = [];
        for (let j = 0; j < data; j++) cols.push(padded.subarray(j * chunk, (j + 1) * chunk));
        if (parity >= 1) {
          const P = Buffer.alloc(chunk);
          for (let j = 0; j < data; j++) xorInto(P, cols[j]!);
          cols.push(P);
        }
        if (parity >= 2) {
          const Q = Buffer.alloc(chunk);
          for (let j = 0; j < data; j++) mulXorInto(Q, cols[j]!, gfPow2(j));
          cols.push(Q);
        }
        for (let col = 0; col < cols.length; col++) {
          for (const p of columnMembers(level, n, s, col)) await write(p, cols[col]!);
        }
        if (bytes.length < stripeBytes) break;
      }
    } catch (err) {
      for (const sink of sinks.values()) sink.pt.destroy();
      await Promise.allSettled([...sinks.values()].map((x) => x.done));
      throw err instanceof StorageError ? err : new StorageError('Failed to read the upload', err);
    }
    for (const sink of sinks.values()) if (!sink.failed) sink.pt.end();
    await Promise.all([...sinks.values()].map((x) => x.done));
    return { size, failed: targets.filter((p) => sinks.get(p)!.failed) };
  }

  private async writeManifest(key: string, manifest: RaidManifest, skip: Set<number>): Promise<void> {
    const body = Buffer.from(JSON.stringify(manifest));
    const results = await Promise.allSettled(
      this.members.map((m, p) => (skip.has(p) ? Promise.reject(new Error('skipped')) : m.driver.put(key + RAID_META_SUFFIX, body, { contentType: 'application/json', size: body.length }))),
    );
    if (!results.some((r) => r.status === 'fulfilled')) throw new StorageError('Could not write the object manifest to any pool member');
  }

  async put(key: string, body: Readable | Buffer, opts: PutOptions): Promise<void> {
    const n = this.members.length;
    const chunk = this.chunkFor(opts.size ?? (Buffer.isBuffer(body) ? body.length : undefined));
    const offline = this.members.flatMap((_, p) => (this.isDown(p) ? [p] : []));
    if (offline.length > this.geometry.tolerance) {
      if (!Buffer.isBuffer(body)) body.destroy();
      throw new StorageError(`${offline.length} of ${n} pool members are offline; ${this.level} tolerates ${this.geometry.tolerance}`);
    }
    const targets = this.members.map((_, p) => p).filter((p) => !offline.includes(p));
    // An overwrite of a reshaped object leaves its old shards under a separate key: remove them afterwards.
    const previous = await this.readManifest(key).catch(() => null);
    const { size, failed } = await this.writeShards(key, body, chunk, targets);
    const missing = [...offline, ...failed].sort((a, b) => a - b);
    if (missing.length > this.geometry.tolerance) {
      await this.delete(key).catch(() => undefined);
      throw new StorageError(`Write failed on ${missing.length} of ${n} pool members; ${this.level} tolerates ${this.geometry.tolerance}`);
    }
    await this.writeManifest(
      key,
      { v: 1, level: this.level, members: this.members.map((m) => m.id), chunk, size, contentType: opts.contentType, missing, updatedAt: new Date().toISOString() },
      new Set(missing),
    );
    if (previous?.shardKey && previous.shardKey !== key) await Promise.allSettled(this.members.map((mem) => mem.driver.delete(previous.shardKey!)));
  }

  // ---------------------------------------------------------------------------------- reading

  async readManifest(key: string): Promise<RaidManifest | null> {
    for (const p of this.preferredOrder()) {
      try {
        const stream = await this.members[p]!.driver.get(key + RAID_META_SUFFIX);
        const parts: Buffer[] = [];
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
        const m = JSON.parse(Buffer.concat(parts).toString('utf8')) as RaidManifest;
        if (m.v === 1) return m;
      } catch (err) {
        if (!(err instanceof StorageError && /not found/i.test(err.message))) this.markDown(p);
      }
    }
    return null;
  }

  /** Positions whose shard for this manifest is missing or belongs to a replaced member. */
  stalePositions(m: RaidManifest): number[] {
    return m.members.flatMap((id, p) => (m.missing.includes(p) || this.members[p]?.id !== id ? [p] : []));
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const m = await this.readManifest(key);
    if (!m) throw new StorageError('Object not found');
    this.layoutOf(m);
    if (m.size === 0) return Readable.from([]);
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? m.size - 1, m.size - 1);
    if (start > end) return Readable.from([]);
    return Readable.from(this.readStripes(m.shardKey ?? key, m, start, end));
  }

  private async *readStripes(key: string, m: RaidManifest, start: number, end: number): AsyncGenerator<Buffer> {
    const { level, n, geometry } = this.layoutOf(m);
    const { data, parity } = geometry;
    const chunk = m.chunk;
    const stripeBytes = chunk * data;
    const s0 = Math.floor(start / stripeBytes);
    const s1 = Math.floor(end / stripeBytes);
    const positions = Array.from({ length: n }, (_, p) => p);
    const dead = new Set([...this.stalePositions(m), ...positions.filter((p) => this.isDown(p))]);
    const readers = new Map<number, ChunkReader>();
    const mirrored = level === 'RAID1' || level === 'RAID10';
    const cols = mirrored ? (level === 'RAID1' ? 1 : n / 2) : data + parity;

    const open = async (p: number, fromStripe: number): Promise<ChunkReader | null> => {
      if (dead.has(p)) return null;
      let r = readers.get(p);
      if (r) return r;
      try {
        r = new ChunkReader(await this.members[p]!.driver.get(key, { start: fromStripe * chunk, end: (s1 + 1) * chunk - 1 }));
        readers.set(p, r);
        return r;
      } catch {
        dead.add(p);
        this.markDown(p);
        return null;
      }
    };
    const readFrom = async (p: number, s: number): Promise<Buffer | null> => {
      const r = await open(p, s);
      if (!r) return null;
      try {
        return Buffer.from(await r.read(chunk));
      } catch {
        r.destroy();
        readers.delete(p);
        dead.add(p);
        this.markDown(p);
        return null;
      }
    };

    try {
      if (!mirrored) await Promise.all(positions.map((p) => open(p, s0)));
      for (let s = s0; s <= s1; s++) {
        const got: (Buffer | null)[] = [];
        for (let col = 0; col < cols; col++) {
          let buf: Buffer | null = null;
          if (mirrored) {
            // Read one copy; fall back to the mirror (opened at this stripe) if it fails.
            for (const p of columnMembers(level, n, s, col)) {
              buf = await readFrom(p, s);
              if (buf) break;
            }
            if (!buf) throw new StorageError(`Every copy of column ${col} is unavailable`);
          } else {
            buf = await readFrom(columnMembers(level, n, s, col)[0]!, s);
          }
          got.push(buf);
        }
        const stripe = Buffer.concat(mirrored ? (got as Buffer[]) : reconstructStripe(got, data, parity));
        const lo = s === s0 ? start - s * stripeBytes : 0;
        const hi = s === s1 ? end - s * stripeBytes + 1 : stripeBytes;
        yield stripe.subarray(lo, hi);
      }
    } finally {
      for (const r of readers.values()) r.destroy();
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const m = await this.readManifest(key);
    return m ? { size: m.size, lastModified: new Date(m.updatedAt) } : null;
  }

  async delete(key: string): Promise<void> {
    const m = await this.readManifest(key).catch(() => null);
    const keys = new Set([key, key + RAID_META_SUFFIX, ...(m?.shardKey ? [m.shardKey] : [])]);
    await Promise.allSettled(this.members.flatMap((mem) => [...keys].map((k) => mem.driver.delete(k))));
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const m = await this.readManifest(sourceKey);
    if (!m) throw new StorageError('Object not found');
    await this.put(destKey, await this.get(sourceKey), { contentType: m.contentType, size: m.size });
  }

  // ---------------------------------------------------------------------------------- health & maintenance

  async memberHealth(): Promise<{ position: number; id: string; ok: boolean; error?: string }[]> {
    return Promise.all(
      this.members.map(async (m, position) => {
        try {
          await m.driver.healthCheck();
          return { position, id: m.id, ok: true };
        } catch (err) {
          return { position, id: m.id, ok: false, error: (err as Error).message.slice(0, 300) };
        }
      }),
    );
  }

  async healthCheck(): Promise<void> {
    const health = await this.memberHealth();
    const failed = health.filter((h) => !h.ok);
    if (failed.length > this.geometry.tolerance) {
      throw new StorageError(`${failed.length} of ${this.members.length} pool members are unhealthy (${this.level} tolerates ${this.geometry.tolerance}): ${failed.map((f) => `#${f.position + 1} ${f.error}`).join('; ')}`);
    }
  }

  async capacity(): Promise<CapacityInfo> {
    const caps = await Promise.all(this.members.map((m) => m.driver.capacity().catch(() => ({ total: null, available: null }))));
    const known = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
    const totals = known(caps.map((c) => c.total));
    const avail = known(caps.map((c) => c.available));
    return {
      total: totals.length ? Math.min(...totals) * this.geometry.data : null,
      available: avail.length ? Math.min(...avail) * this.geometry.data : null,
    };
  }

  /** Object keys stored in the pool (union across reachable members, so degraded objects are included). */
  async *listKeys(prefix = ''): AsyncIterable<string> {
    const seen = new Set<string>();
    let listed = 0;
    for (const p of this.preferredOrder()) {
      const driver = this.members[p]!.driver;
      if (!driver.listKeys || this.isDown(p)) continue;
      try {
        for await (const k of driver.listKeys(prefix)) {
          if (!k.endsWith(RAID_META_SUFFIX)) continue;
          const key = k.slice(0, -RAID_META_SUFFIX.length);
          if (seen.has(key)) continue;
          seen.add(key);
          yield key;
        }
        listed++;
      } catch {
        this.markDown(p);
      }
    }
    if (!listed) throw new StorageError('No pool member could list its objects');
  }

  /**
   * Brings an object's shards back to full redundancy: rewrites shards that were skipped during a
   * degraded write or that belong to a replaced member. With `verify`, every member's shard is
   * also checked for presence and length (a full scrub). Objects written before the pool was
   * expanded (or its level changed) are reshaped onto the current layout.
   */
  async repair(key: string, opts: { verify?: boolean; positions?: number[] } = {}): Promise<RepairResult> {
    const m = await this.readManifest(key);
    if (!m) return 'missing';
    const layout = this.layoutOf(m);
    if (!this.sameLayout(layout, this.layout)) return this.reshape(key, m);
    const shardKey = m.shardKey ?? key;
    const targets = new Set([...this.stalePositions(m), ...(opts.positions ?? []).filter((p) => p < layout.n)]);
    if (opts.verify) {
      const expected = this.shardLength(m.size, m.chunk, layout);
      await Promise.all(
        this.members.slice(0, layout.n).map(async (mem, p) => {
          if (targets.has(p) || this.isDown(p)) return;
          const info = await mem.driver.head(shardKey).catch(() => null);
          if (!info || info.size !== expected) targets.add(p);
        }),
      );
    }
    const list = [...targets].filter((p) => !this.isDown(p)).sort((a, b) => a - b);
    if (!list.length) return targets.size ? 'partial' : 'ok';
    // Stale positions are excluded from reads, so the data is rebuilt from the healthy members.
    const source = await this.get(key);
    const { failed } = await this.writeShards(shardKey, source, m.chunk, list, layout);
    const stillMissing = [...[...targets].filter((p) => !list.includes(p)), ...failed].sort((a, b) => a - b);
    await this.writeManifest(key, { ...m, members: this.members.slice(0, layout.n).map((x) => x.id), missing: stillMissing, updatedAt: new Date().toISOString() }, new Set(stillMissing));
    return stillMissing.length ? 'partial' : 'repaired';
  }

  /**
   * Rewrites an object onto the pool's current layout (after nodes were added or the level changed).
   * The new shards go under a fresh shard key; the manifest is switched over only once they are
   * written, and the old shards are removed last, so a failure at any point leaves a readable copy.
   */
  private async reshape(key: string, m: RaidManifest): Promise<RepairResult> {
    const offline = this.members.flatMap((_, p) => (this.isDown(p) ? [p] : []));
    if (offline.length > this.geometry.tolerance) return 'partial';
    const oldShardKey = m.shardKey ?? key;
    const shardKey = `${key}.r${Date.now().toString(36)}`;
    const chunk = this.chunkFor(m.size);
    const targets = this.members.map((_, p) => p).filter((p) => !offline.includes(p));
    const { failed } = await this.writeShards(shardKey, await this.get(key), chunk, targets);
    const missing = [...offline, ...failed].sort((a, b) => a - b);
    if (missing.length > this.geometry.tolerance) {
      await Promise.allSettled(this.members.map((mem) => mem.driver.delete(shardKey)));
      return 'partial';
    }
    await this.writeManifest(
      key,
      { v: 1, level: this.level, members: this.members.map((x) => x.id), chunk, size: m.size, contentType: m.contentType, missing, updatedAt: new Date().toISOString(), shardKey },
      new Set(missing),
    );
    await Promise.allSettled(this.members.map((mem) => mem.driver.delete(oldShardKey)));
    return missing.length ? 'partial' : 'reshaped';
  }
}
