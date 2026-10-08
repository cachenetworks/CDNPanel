import { describe, expect, it, vi } from 'vitest';

const capacity = vi.fn();
vi.mock('../lib/storageRegistry.js', () => ({ driverFor: () => ({ capacity }) }));

import { providerSpace, smallestKnownLimit } from './storageCapacity.js';
import type { StorageProvider } from '@cdn/database';

function provider(quota: bigint | null): StorageProvider {
  return { capacity: quota } as StorageProvider;
}

describe('storage capacity', () => {
  it('uses the smaller of real host free space and remaining provider quota', async () => {
    capacity.mockResolvedValueOnce({ total: 1000, available: 240 });
    const actual = await providerSpace(provider(850n), 800);
    expect(actual.capacity).toBe(850);
    expect(actual.available).toBe(50);
    expect(actual.disk_total).toBe(1000);
    expect(actual.disk_free).toBe(240);
    expect(actual.disk_other_used_estimate).toBe(0);
  });

  it('accounts for unrelated disk usage without assuming a CDN quota', async () => {
    capacity.mockResolvedValueOnce({ total: 1000, available: 120 });
    const actual = await providerSpace(provider(null), 200);
    expect(actual.capacity).toBeNull();
    expect(actual.available).toBe(120);
    expect(actual.disk_used).toBe(880);
    expect(actual.disk_other_used_estimate).toBe(680);
  });

  it('preserves unknown cloud capacity and never treats it as unlimited', async () => {
    capacity.mockResolvedValueOnce({ total: null, available: null });
    const unknown = await providerSpace(provider(null), 100);
    expect(unknown.available).toBeNull();
    expect(unknown.disk_free).toBeNull();
    expect(smallestKnownLimit(null, undefined)).toBeNull();
  });
});
