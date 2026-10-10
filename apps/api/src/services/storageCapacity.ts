import { getPrisma, type StorageProvider } from '@cdn/database';
import { driverFor } from '../lib/storageRegistry.js';
import { poolFreeBytes, poolUsableBytes } from './storageNodes.js';

/** Null means the backend did not report a limit; it never means unlimited space. */
export function smallestKnownLimit(...limits: (number | null | undefined)[]): number | null {
  const known = limits.filter((n): n is number => n != null && Number.isFinite(n));
  return known.length ? Math.max(0, Math.min(...known)) : null;
}

export async function providerSpace(provider: StorageProvider, logicalUsed: number) {
  const disk = await driverFor(provider).capacity().catch(() => ({ total: null, available: null }));
  const limit = provider.capacity === null ? null : Number(provider.capacity);
  const quotaRemaining = limit === null ? null : Math.max(0, limit - logicalUsed);
  const available = smallestKnownLimit(disk.available, quotaRemaining);
  const diskUsed = disk.total !== null && disk.available !== null ? Math.max(0, disk.total - disk.available) : null;
  return {
    // Host disk size is not the CDN provider's configured quota.
    capacity: limit,
    available,
    disk_total: disk.total,
    disk_free: disk.available,
    disk_used: diskUsed,
    // CDN logical bytes are not filesystem allocated blocks, so this is an estimate.
    disk_other_used_estimate: diskUsed === null ? null : Math.max(0, diskUsed - logicalUsed),
    configured_capacity: limit,
  };
}

export interface ClusterServer {
  /** Provider id for main / pool / cloud entries; node id for unassigned nodes. */
  id: string;
  name: string;
  /**
   * `main` = this server's own disk; `local` = another local provider on a different volume;
   * `pool` = a RAID pool (usable space after RAID); `cloud` = an object-storage bucket (its quota);
   * `node` = a storage node not in any pool (shown, not counted: files cannot use it yet).
   */
  role: 'main' | 'local' | 'pool' | 'node' | 'cloud';
  /** Provider kind (LOCAL, POOL, S3, R2, B2, MINIO) or REMOTE for nodes. */
  kind: string;
  status: string;
  /** Included in the totals. */
  counted: boolean;
  is_default: boolean;
  total: number | null;
  free: number | null;
  used: number | null;
  /** Pools: RAID level and node names. */
  level?: string;
  nodes?: string[];
  /** Pools: raw disk across its nodes (before RAID overhead). */
  raw_total?: number | null;
  /** Cloud buckets: objects in the bucket at the last scan, and when that was. */
  objects?: number | null;
  checked_at?: string | null;
  partial?: boolean;
}

export interface StorageTotals {
  /** Usable space across every enabled storage option. */
  total: number;
  free: number;
  used: number;
  servers: ClusterServer[];
  online_servers: number;
  /** Physical machines counted (this server + nodes in pools). */
  server_count: number;
  pool_count: number;
  cloud_count: number;
  /** Nodes that are not in a pool yet (listed, not counted). */
  unassigned_nodes: number;
}

function healthToStatus(h: string): string {
  return h === 'healthy' ? 'online' : h === 'unhealthy' ? 'offline' : h === 'degraded' ? 'degraded' : 'unknown';
}

/**
 * Usable storage across every enabled storage option, counted the way files can actually use it:
 *  - this server's disk (and any other local provider on a different volume): real total / free space;
 *  - each RAID pool: usable space after RAID overhead, from its nodes' last reported disks
 *    (a node therefore counts once, through its pool);
 *  - each cloud bucket: its configured quota, minus the measured bucket usage (no quota = no size);
 *  - nodes not in a pool are listed but not counted.
 */
export async function clusterStorage(): Promise<StorageTotals> {
  const prisma = getPrisma();
  const providers = await prisma.storageProvider.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
  const servers: ClusterServer[] = [];

  // Local disks: count each volume once (local providers often share this server's disk).
  const locals = providers.filter((p) => p.kind === 'LOCAL').sort((a, b) => Number((b.publicInfo as Record<string, string>).source === 'environment') - Number((a.publicInfo as Record<string, string>).source === 'environment'));
  const seenVolumes = new Set<string>();
  for (const p of locals) {
    const disk = await driverFor(p).capacity().catch(() => ({ total: null, available: null }));
    const volume = disk.total === null ? `unknown:${p.id}` : `${disk.total}`;
    if (seenVolumes.has(volume)) continue;
    seenVolumes.add(volume);
    const isMain = (p.publicInfo as Record<string, string>).source === 'environment';
    servers.push({
      id: p.id,
      name: isMain ? 'Main server' : p.name,
      role: isMain ? 'main' : 'local',
      kind: 'LOCAL',
      status: disk.total === null ? 'unknown' : 'online',
      counted: disk.total !== null,
      is_default: p.isDefault,
      total: disk.total,
      free: disk.available,
      used: disk.total !== null && disk.available !== null ? disk.total - disk.available : null,
    });
  }

  // RAID pools: usable space after RAID.
  const pools = await prisma.storagePool.findMany({ include: { members: { include: { node: true }, orderBy: { position: 'asc' } } }, orderBy: { createdAt: 'asc' } });
  const pooledNodes = new Set<string>();
  for (const pool of pools) {
    const provider = providers.find((p) => p.id === pool.providerId);
    if (!provider) continue;
    pool.members.forEach((m) => pooledNodes.add(m.nodeId));
    const usable = poolUsableBytes(pool);
    const total = usable === null ? null : Number(usable);
    const free = poolFreeBytes(pool);
    const raw = pool.members.every((m) => m.node.totalBytes !== null) ? pool.members.reduce((a, m) => a + Number(m.node.totalBytes), 0) : null;
    servers.push({
      id: provider.id,
      name: pool.name,
      role: 'pool',
      kind: 'POOL',
      status: pool.status === 'healthy' ? 'online' : pool.status === 'failed' ? 'offline' : pool.status,
      counted: total !== null,
      is_default: provider.isDefault,
      total,
      free,
      used: total !== null && free !== null ? Math.max(0, total - free) : null,
      level: pool.level,
      nodes: pool.members.map((m) => m.node.name),
      raw_total: raw,
    });
  }

  // Cloud buckets: quota minus measured usage.
  const cloud = providers.filter((p) => p.kind !== 'LOCAL' && p.kind !== 'POOL');
  if (cloud.length) {
    const logical = await prisma.file.groupBy({ by: ['storageProviderId'], where: { storageProviderId: { in: cloud.map((p) => p.id) } }, _sum: { size: true } });
    for (const p of cloud) {
      // Prefer the measured bucket size (includes anything not uploaded through the CDN).
      const used = p.bucketUsedBytes !== null ? Number(p.bucketUsedBytes) : Number(logical.find((x) => x.storageProviderId === p.id)?._sum.size ?? 0);
      const total = p.capacity === null ? null : Number(p.capacity);
      servers.push({
        id: p.id,
        name: p.name,
        role: 'cloud',
        kind: p.kind,
        status: healthToStatus(p.healthStatus),
        counted: total !== null,
        is_default: p.isDefault,
        total,
        free: total === null ? null : Math.max(0, total - used),
        used,
        objects: p.bucketObjectCount,
        checked_at: p.usageCheckedAt?.toISOString() ?? null,
        partial: p.bucketUsagePartial,
      });
    }
  }

  // Nodes not in any pool: visible, but files cannot be stored on them until they join a pool.
  const nodes = await prisma.storageNode.findMany({ where: { kind: 'REMOTE' }, orderBy: { createdAt: 'asc' } });
  for (const n of nodes.filter((x) => !pooledNodes.has(x.id))) {
    const total = n.totalBytes === null ? null : Number(n.totalBytes);
    const free = n.freeBytes === null ? null : Number(n.freeBytes);
    servers.push({ id: n.id, name: n.name, role: 'node', kind: 'REMOTE', status: n.enabled ? n.status : 'disabled', counted: false, is_default: false, total, free, used: total !== null && free !== null ? total - free : null });
  }

  const counted = servers.filter((x) => x.counted);
  const sum = (k: 'total' | 'free' | 'used') => counted.reduce((a, x) => a + (x[k] ?? 0), 0);
  return {
    total: sum('total'),
    free: sum('free'),
    used: sum('used'),
    servers,
    online_servers: servers.filter((x) => x.status === 'online').length,
    server_count: servers.filter((x) => x.role === 'main' || x.role === 'local').length + pooledNodes.size,
    pool_count: servers.filter((x) => x.role === 'pool').length,
    cloud_count: servers.filter((x) => x.role === 'cloud').length,
    unassigned_nodes: servers.filter((x) => x.role === 'node').length,
  };
}
