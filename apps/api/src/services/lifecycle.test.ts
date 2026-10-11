import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { File } from '@cdn/database';

const mocks = vi.hoisted(() => ({
  head: vi.fn(), put: vi.fn(), get: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), cleanup: vi.fn(), space: vi.fn(), source: vi.fn(),
  provider: { enabled: true, bucketUsedBytes: null },
}));
vi.mock('@cdn/database', () => ({ getPrisma: () => ({
  file: { aggregate: async () => ({ _sum: { size: 0n } }) },
  $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ file: { updateMany: mocks.updateMany }, fileReplica: { deleteMany: mocks.deleteMany } }),
}) }));
vi.mock('../lib/storageRegistry.js', () => ({ driverForId: async () => ({ provider: mocks.provider, driver: { head: mocks.head, put: mocks.put, get: mocks.get } }) }));
vi.mock('./storageCapacity.js', () => ({ providerSpace: mocks.space }));
vi.mock('./replication.js', () => ({ openFileStream: mocks.source }));
vi.mock('./files.js', () => ({ deleteUnreferencedObjects: mocks.cleanup, deleteFiles: vi.fn(), trashFiles: vi.fn() }));
vi.mock('../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../lib/settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../lib/webhooks.js', () => ({ emitWebhookEvent: vi.fn() }));
vi.mock('../lib/zones.js', () => ({ getZones: vi.fn() }));
vi.mock('./purge.js', () => ({ autoPurgeFiles: vi.fn() }));

import { moveFileStorage } from './lifecycle.js';

const file = { id: 'file_test', storageProviderId: 'source', storageKey: 'objects/test', size: 5n, mimeType: 'text/plain', status: 'READY', deletedAt: null, version: 1, sha256: createHash('sha256').update('hello').digest('hex') } as File;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.provider.enabled = true;
  mocks.head.mockResolvedValue({ size: 5 });
  mocks.get.mockImplementation(async () => Readable.from(['hello']));
  mocks.source.mockImplementation(async () => ({ stream: Readable.from(['hello']) }));
  mocks.space.mockResolvedValue({ available: 100 });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe('storage moves', () => {
  it('copies and verifies before switching and cleaning up the source', async () => {
    mocks.head.mockResolvedValueOnce(null);
    await moveFileStorage(file, 'b2', 'standard');
    expect(mocks.put).toHaveBeenCalledWith(file.storageKey, expect.any(Readable), { contentType: 'text/plain', size: 5 });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { storageProviderId: 'b2', storageClass: 'standard' } }));
    expect(mocks.cleanup).toHaveBeenCalledWith([{ providerId: 'source', key: file.storageKey }]);
    expect(mocks.get.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateMany.mock.invocationCallOrder[0]!);
  });
  it('rejects same-sized destination corruption without switching', async () => {
    mocks.get.mockResolvedValue(Readable.from(['wrong']));
    await expect(moveFileStorage(file, 'pool')).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it('rejects insufficient space before uploading', async () => {
    mocks.head.mockResolvedValueOnce(null);
    mocks.space.mockResolvedValue({ available: 4 });
    await expect(moveFileStorage(file, 'pool')).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('preserves the source when the file changes concurrently', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(moveFileStorage(file, 'pool')).rejects.toMatchObject({ code: 'conflict' });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it('rejects disabled destinations', async () => {
    mocks.provider.enabled = false;
    await expect(moveFileStorage(file, 'pool')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('leaves files on the requested provider alone', async () => {
    await moveFileStorage(file, 'source');
    expect(mocks.head).not.toHaveBeenCalled();
  });
});
