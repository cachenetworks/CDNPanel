import { getPrisma, type StorageProvider } from '@cdn/database';
import { driverFor } from '../lib/storageRegistry.js';

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
  name: string;
  /** `main` = this CDN server's own storage disk; `node` = a remote storage node; `cloud` = an object-storage bucket. */
  role: 'main' | 'node' | 'cloud';
  /** Provider kind for cloud buckets (S3, R2, B2, MINIO). */
  kind?: string;
  status: string;
  /** For cloud buckets: the quota configured on the provider (object storage has no fixed size). */
  total: number | null;
  free: number | null;
  used: number | null;
  /** Cloud buckets: objects in the bucket at the last scan, and when that was. */
  objects?: number | null;
  checked_at?: string | null;
  partial?: boolean;
}

/**
 * Storage across every server and bucket: this CDN server's disk, each remote storage node's disk
 * (as last reported by the node health check), and each enabled cloud bucket (its configured quota,
 * with usage from the periodic bucket scan). Local-directory nodes live on this server's disk and
 * are not counted twice. Buckets without a quota have no size to add, so they count as used only.
 */
export async function clusterStorage(): Promise<{ total: number; free: number; used: number; servers: ClusterServer[]; online_servers: number; server_count: number; cloud_count: number }> {
  const prisma = getPrisma();
  const providers = await prisma.storageProvider.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
  const main = providers.find((p) => p.kind === 'LOCAL' && (p.publicInfo as Record<string, string>).source === 'environment');
  const servers: ClusterServer[] = [];
  if (main) {
    const disk = await driverFor(main).capacity().catch(() => ({ total: null, available: null }));
    servers.push({ name: 'Main server', role: 'main', status: disk.total === null ? 'unknown' : 'online', total: disk.total, free: disk.available, used: disk.total !== null && disk.available !== null ? disk.total - disk.available : null });
  }
  const nodes = await prisma.storageNode.findMany({ where: { kind: 'REMOTE' }, orderBy: { createdAt: 'asc' } });
  for (const n of nodes) {
    const total = n.totalBytes === null ? null : Number(n.totalBytes);
    const free = n.freeBytes === null ? null : Number(n.freeBytes);
    servers.push({ name: n.name, role: 'node', status: n.enabled ? n.status : 'disabled', total, free, used: total !== null && free !== null ? total - free : null });
  }
  const cloud = providers.filter((p) => p.kind !== 'LOCAL' && p.kind !== 'POOL');
  if (cloud.length) {
    const logical = await prisma.file.groupBy({ by: ['storageProviderId'], where: { storageProviderId: { in: cloud.map((p) => p.id) } }, _sum: { size: true } });
    for (const p of cloud) {
      // Prefer the measured bucket size (includes anything not uploaded through the CDN).
      const used = p.bucketUsedBytes !== null ? Number(p.bucketUsedBytes) : Number(logical.find((x) => x.storageProviderId === p.id)?._sum.size ?? 0);
      const total = p.capacity === null ? null : Number(p.capacity);
      servers.push({
        name: p.name,
        role: 'cloud',
        kind: p.kind,
        status: p.healthStatus === 'healthy' ? 'online' : p.healthStatus === 'unhealthy' ? 'offline' : 'unknown',
        total,
        free: total === null ? null : Math.max(0, total - used),
        used,
        objects: p.bucketObjectCount,
        checked_at: p.usageCheckedAt?.toISOString() ?? null,
        partial: p.bucketUsagePartial,
      });
    }
  }
  const sum = (k: 'total' | 'free' | 'used') => servers.reduce((a, s) => a + (s[k] ?? 0), 0);
  return {
    total: sum('total'),
    free: sum('free'),
    used: sum('used'),
    servers,
    online_servers: servers.filter((s) => s.status === 'online').length,
    server_count: servers.filter((s) => s.role !== 'cloud').length,
    cloud_count: servers.filter((s) => s.role === 'cloud').length,
  };
}
