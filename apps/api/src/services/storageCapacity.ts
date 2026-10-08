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
  /** `main` = this CDN server's own storage disk; `node` = a remote storage node. */
  role: 'main' | 'node';
  status: string;
  total: number | null;
  free: number | null;
  used: number | null;
}

/**
 * Physical storage across every server: this CDN server's disk plus each remote storage node's disk
 * (as last reported by the node health check). Local-directory nodes live on this server's disk and
 * are not counted twice.
 */
export async function clusterStorage(): Promise<{ total: number; free: number; used: number; servers: ClusterServer[]; online_servers: number }> {
  const prisma = getPrisma();
  const main = (await prisma.storageProvider.findMany({ where: { kind: 'LOCAL', enabled: true }, orderBy: { createdAt: 'asc' } })).find((p) => (p.publicInfo as Record<string, string>).source === 'environment');
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
  const sum = (k: 'total' | 'free' | 'used') => servers.reduce((a, s) => a + (s[k] ?? 0), 0);
  return { total: sum('total'), free: sum('free'), used: sum('used'), servers, online_servers: servers.filter((s) => s.status === 'online').length };
}
