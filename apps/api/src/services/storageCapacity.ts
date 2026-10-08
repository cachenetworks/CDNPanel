import type { StorageProvider } from '@cdn/database';
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
