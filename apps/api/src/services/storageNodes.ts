import path from 'node:path';
import { getPrisma, type StorageNode, type StoragePool, type StoragePoolMember } from '@cdn/database';
import {
  LocalStorageDriver,
  NodeStorageDriver,
  RaidStorageDriver,
  raidGeometry,
  raidUsableBytes,
  type PoolConfig,
  type PoolMemberConfig,
  type RaidLevel,
  type StorageDriver,
} from '@cdn/storage';
import { AppError, decryptJson, encryptJson } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';
import { enqueuePoolRepair } from '../lib/queue.js';
import { driverForId, encryptProviderConfig, forgetDriver } from '../lib/storageRegistry.js';

const log = baseLogger.child({ service: 'storage-nodes' });

type PoolWithMembers = StoragePool & { members: (StoragePoolMember & { node: StorageNode })[] };

// ─── Node secrets & drivers ─────────────────────────────────────────────────

function tokenAad(nodeId: string): string {
  return `storage_node:${nodeId}`;
}

export function encryptNodeToken(nodeId: string, token: string): string {
  return encryptJson(getKeyring(), { token }, tokenAad(nodeId));
}

function nodeToken(node: StorageNode): string {
  if (!node.tokenEnc) throw new AppError('validation_failed', 'The node has no token configured.');
  return decryptJson<{ token: string }>(getKeyring(), node.tokenEnc, tokenAad(node.id)).token;
}

/** Local node directories must live beneath the same base directory as local storage providers. */
export function resolveLocalNodePath(input: string): string {
  const base = path.resolve(env().LOCAL_STORAGE_ALLOWED_ROOT ?? path.dirname(path.resolve(env().LOCAL_STORAGE_PATH)));
  const root = path.resolve(base, input);
  const rel = path.relative(base, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('validation_failed', `Local node directories must be inside ${base}.`);
  return root;
}

export function memberConfig(node: StorageNode): PoolMemberConfig {
  const offline = !node.enabled || node.status === 'offline';
  return node.kind === 'REMOTE' ? { id: node.id, kind: 'REMOTE', url: node.url, token: nodeToken(node), offline } : { id: node.id, kind: 'LOCAL', root: node.path, offline };
}

export function nodeDriver(node: Pick<StorageNode, 'kind' | 'url' | 'path'> & { token?: string; tokenEnc?: string | null; id: string }): StorageDriver {
  if (node.kind === 'REMOTE') return new NodeStorageDriver({ url: node.url, token: node.token ?? nodeToken(node as StorageNode), timeoutMs: 10_000 });
  return new LocalStorageDriver({ root: node.path });
}

export interface NodeProbe {
  online: boolean;
  total: number | null;
  free: number | null;
  latencyMs: number;
  version: string | null;
  error: string | null;
}

/** Contacts a node: reachability, write test and disk space. */
export async function probeNode(driver: StorageDriver): Promise<NodeProbe> {
  const started = Date.now();
  try {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 15s')), 15_000));
    const version = driver instanceof NodeStorageDriver ? (await Promise.race([driver.status(), timeout])).version : null;
    await Promise.race([driver.healthCheck(), timeout]);
    const cap = await driver.capacity();
    return { online: true, total: cap.total, free: cap.available, latencyMs: Date.now() - started, version, error: null };
  } catch (err) {
    return { online: false, total: null, free: null, latencyMs: Date.now() - started, version: null, error: (err as Error).message.slice(0, 300) };
  }
}

// ─── Pools ──────────────────────────────────────────────────────────────────

export async function loadPool(poolId: string): Promise<PoolWithMembers> {
  const pool = await getPrisma().storagePool.findUnique({ where: { id: poolId }, include: { members: { include: { node: true }, orderBy: { position: 'asc' } } } });
  if (!pool) throw new AppError('not_found', 'Storage pool not found.');
  return pool;
}

export function poolConfig(pool: PoolWithMembers): PoolConfig {
  return { level: pool.level as RaidLevel, chunkSize: pool.chunkSize, members: pool.members.map((m) => memberConfig(m.node)) };
}

/** healthy | degraded | failed, from how many members are offline versus what the level tolerates. */
export function poolHealth(level: RaidLevel, members: Pick<StorageNode, 'enabled' | 'status'>[]): 'healthy' | 'degraded' | 'failed' {
  const offline = members.filter((n) => !n.enabled || n.status === 'offline').length;
  if (offline === 0) return 'healthy';
  return offline <= raidGeometry(level, members.length).tolerance ? 'degraded' : 'failed';
}

/** Rewrites the pool's provider configuration (member addresses, tokens, offline flags) and drops cached drivers. */
export async function syncPoolProvider(poolId: string): Promise<PoolWithMembers> {
  const pool = await loadPool(poolId);
  const prisma = getPrisma();
  const status = poolHealth(pool.level as RaidLevel, pool.members.map((m) => m.node));
  await prisma.storageProvider.update({
    where: { id: pool.providerId },
    data: {
      configEnc: encryptProviderConfig(pool.providerId, { kind: 'POOL', pool: poolConfig(pool) }),
      publicInfo: { pool_id: pool.id, level: pool.level, nodes: String(pool.members.length) },
      capacity: poolUsableBytes(pool),
    },
  });
  if (status !== pool.status) await prisma.storagePool.update({ where: { id: pool.id }, data: { status } });
  forgetDriver(pool.providerId);
  return { ...pool, status };
}

/** Usable capacity from the members' last reported disk sizes (null until every member has reported). */
export function poolUsableBytes(pool: PoolWithMembers): bigint | null {
  const sizes = pool.members.map((m) => (m.node.totalBytes === null ? null : Number(m.node.totalBytes)));
  if (!sizes.length || sizes.some((s) => s === null)) return null;
  return BigInt(Math.floor(raidUsableBytes(pool.level as RaidLevel, sizes as number[])));
}

export function poolFreeBytes(pool: PoolWithMembers): number | null {
  const free = pool.members.map((m) => (m.node.freeBytes === null ? null : Number(m.node.freeBytes)));
  if (!free.length || free.some((s) => s === null)) return null;
  return raidUsableBytes(pool.level as RaidLevel, free as number[]);
}

export async function poolDriver(pool: Pick<StoragePool, 'providerId'>): Promise<RaidStorageDriver> {
  const { driver } = await driverForId(pool.providerId);
  if (!(driver instanceof RaidStorageDriver)) throw new AppError('internal_error', 'Pool provider is misconfigured.');
  return driver;
}

// ─── Health monitoring ──────────────────────────────────────────────────────

/** Probes every node, records status / disk space, and reacts to nodes going offline or coming back. */
export async function checkNodes(): Promise<{ checked: number; changed: number }> {
  const prisma = getPrisma();
  const nodes = await prisma.storageNode.findMany({ include: { memberships: true } });
  const touchedPools = new Set<string>();
  const recovered = new Set<string>();
  let changed = 0;
  for (const node of nodes) {
    if (!node.enabled) continue;
    let probe: NodeProbe;
    try {
      probe = await probeNode(nodeDriver(node));
    } catch (err) {
      probe = { online: false, total: null, free: null, latencyMs: 0, version: null, error: (err as Error).message };
    }
    const status = probe.online ? 'online' : 'offline';
    await prisma.storageNode.update({
      where: { id: node.id },
      data: {
        status,
        latencyMs: probe.latencyMs,
        lastError: probe.error,
        ...(probe.online ? { lastSeenAt: new Date(), totalBytes: probe.total === null ? null : BigInt(probe.total), freeBytes: probe.free === null ? null : BigInt(probe.free), version: probe.version } : {}),
      },
    });
    if (status !== node.status) {
      changed++;
      log[probe.online ? 'info' : 'warn']({ node_id: node.id, name: node.name, status, error: probe.error }, 'storage node status changed');
      for (const m of node.memberships) {
        touchedPools.add(m.poolId);
        if (probe.online && node.status === 'offline') recovered.add(m.poolId);
      }
    }
    // Disk sizes feed pool capacity, so refresh pools whenever a probe succeeds.
    if (probe.online) for (const m of node.memberships) touchedPools.add(m.poolId);
  }
  for (const poolId of touchedPools) await syncPoolProvider(poolId).catch((err: unknown) => log.error({ err, pool_id: poolId }, 'pool sync failed'));
  // A node that came back missed every write made while it was away: catch it up.
  for (const poolId of recovered) await enqueuePoolRepair({ poolId, reason: 'node recovered' });
  return { checked: nodes.length, changed };
}

/** Queues a catch-up pass for every pool that is not failed (cheap: only degraded objects are rewritten). */
export async function scrubPools(): Promise<number> {
  const pools = await getPrisma().storagePool.findMany({ where: { status: { not: 'failed' } } });
  for (const p of pools) await enqueuePoolRepair({ poolId: p.id, reason: 'scheduled scrub' });
  return pools.length;
}

// ─── Rebuild ────────────────────────────────────────────────────────────────

export interface RebuildState {
  running: boolean;
  reason: string;
  verify: boolean;
  positions: number[];
  started_at: string;
  finished_at: string | null;
  scanned: number;
  repaired: number;
  /** Objects moved onto the pool's current layout after an expansion. */
  reshaped: number;
  failed: number;
  last_error: string | null;
}

/**
 * Walks every object in a pool and restores full redundancy: shards skipped while a node was down,
 * shards of a replaced node (new member id), and — with `verify` — shards that are missing or truncated.
 */
export async function runPoolRepair(poolId: string, opts: { verify?: boolean; positions?: number[]; reason?: string } = {}): Promise<RebuildState> {
  const prisma = getPrisma();
  const pool = await syncPoolProvider(poolId);
  const driver = await poolDriver(pool);
  const state: RebuildState = {
    running: true,
    reason: opts.reason ?? 'manual',
    verify: Boolean(opts.verify),
    positions: opts.positions ?? [],
    started_at: new Date().toISOString(),
    finished_at: null,
    scanned: 0,
    repaired: 0,
    reshaped: 0,
    failed: 0,
    last_error: null,
  };
  const save = () => prisma.storagePool.update({ where: { id: poolId }, data: { rebuildState: state as object } });
  await save();
  let lastSave = Date.now();
  try {
    const inflight = new Set<Promise<void>>();
    for await (const key of driver.listKeys()) {
      const task = driver
        .repair(key, { verify: opts.verify, positions: opts.positions })
        .then((r) => {
          state.scanned++;
          if (r === 'repaired') state.repaired++;
          if (r === 'reshaped') state.reshaped++;
          if (r === 'partial') state.failed++;
        })
        .catch((err: unknown) => {
          state.scanned++;
          state.failed++;
          state.last_error = `${key}: ${(err as Error).message}`.slice(0, 300);
        })
        .finally(() => inflight.delete(task));
      inflight.add(task);
      if (inflight.size >= 4) await Promise.race(inflight);
      if (Date.now() - lastSave > 5000) {
        lastSave = Date.now();
        await save();
      }
    }
    await Promise.all(inflight);
  } catch (err) {
    state.last_error = (err as Error).message.slice(0, 300);
    state.failed++;
  }
  state.running = false;
  state.finished_at = new Date().toISOString();
  await save();
  log.info({ pool_id: poolId, ...state }, 'pool repair finished');
  return state;
}
