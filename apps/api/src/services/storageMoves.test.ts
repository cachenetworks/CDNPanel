import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { File } from '@cdn/database';
import type { StorageMoveJob } from '../lib/queue.js';

const mocks = vi.hoisted(() => ({ file: vi.fn(), user: vi.fn(), move: vi.fn(), audit: vi.fn(), hidden: vi.fn(), folder: vi.fn(), access: vi.fn() }));
vi.mock('@cdn/database', () => ({ getPrisma: () => ({ file: { findUnique: mocks.file }, user: { findUnique: mocks.user }, folder: { findUnique: mocks.folder } }) }));
vi.mock('./lifecycle.js', () => ({ moveFileStorage: mocks.move }));
vi.mock('../lib/audit.js', () => ({ audit: mocks.audit }));
vi.mock('../lib/folders.js', () => ({ hiddenFolderIds: mocks.hidden, canAccessChain: mocks.access, getFolderChain: async () => [] }));

import { initialMoveProgress, localMoveScope, runStorageMove } from './storageMoves.js';

const file = (id: string, provider = 'local') => ({ id, name: `${id}.txt`, storageProviderId: provider, status: 'READY', deletedAt: null, folderId: null }) as File;
function job(ids: string[], progress: unknown = 0) {
  return { id: 'job-1', data: { fileIds: ids, sourceProviderIds: ['local'], targetProviderId: 'b2', targetName: 'B2', userId: 'user-1' }, progress, updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job<StorageMoveJob>;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ status: 'ACTIVE', roles: [{ roleId: 'staff', role: { permissions: [{ permissionKey: 'files.edit' }, { permissionKey: 'storage.manage' }] } }] });
  mocks.file.mockImplementation(async ({ where }: { where: { id: string } }) => file(where.id));
  mocks.hidden.mockResolvedValue([]);
  mocks.access.mockReturnValue(true);
});

describe('background local storage moves', () => {
  it('continues after a file fails and reports accurate progress', async () => {
    mocks.move.mockRejectedValueOnce(new Error('B2 unavailable')).mockResolvedValueOnce(undefined);
    const task = job(['one', 'two']);
    const result = await runStorageMove(task);
    expect(result).toMatchObject({ total: 2, processed: 2, moved: 1, failed: 1, skipped: 0, current_file: null });
    expect(result.failures).toEqual([{ id: 'one', name: 'one.txt', error: 'B2 unavailable' }]);
    expect(mocks.move).toHaveBeenCalledTimes(2);
    expect(task.updateProgress).toHaveBeenLastCalledWith(result);
  });
  it('resumes from its checkpoint without moving completed files again', async () => {
    const progress = { ...initialMoveProgress(3), processed: 1, moved: 1 };
    mocks.file.mockResolvedValueOnce(file('two', 'b2')).mockResolvedValueOnce(file('three'));
    const result = await runStorageMove(job(['one', 'two', 'three'], progress));
    expect(result).toMatchObject({ processed: 3, moved: 3 });
    expect(mocks.move).toHaveBeenCalledTimes(1);
    expect(mocks.file.mock.calls.map(([args]) => args.where.id)).toEqual(['two', 'three']);
  });
  it('skips deleted, missing, unready and externally relocated files', async () => {
    mocks.file.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...file('deleted'), deletedAt: new Date() })
      .mockResolvedValueOnce({ ...file('processing'), status: 'PROCESSING' })
      .mockResolvedValueOnce(file('pool', 'another-pool'));
    expect(await runStorageMove(job(['missing', 'deleted', 'processing', 'pool']))).toMatchObject({ processed: 4, moved: 0, skipped: 4 });
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it('checks current folder access before moving', async () => {
    mocks.file.mockResolvedValue({ ...file('private'), folderId: 'restricted' });
    mocks.folder.mockResolvedValue({ path: '/restricted' });
    mocks.access.mockReturnValue(false);
    expect(await runStorageMove(job(['private']))).toMatchObject({ failed: 1, moved: 0 });
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it('rejects a job whose user has been disabled', async () => {
    mocks.user.mockResolvedValue({ status: 'DISABLED', roles: [] });
    await expect(runStorageMove(job(['one']))).rejects.toMatchObject({ code: 'forbidden' });
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it('limits the source scope to local providers and visible active files', async () => {
    mocks.hidden.mockResolvedValue(['secret-folder']);
    const scope = await localMoveScope({} as Parameters<typeof localMoveScope>[0]);
    expect(scope).toEqual({ storageProvider: { kind: 'LOCAL' }, deletedAt: null, OR: [{ folderId: null }, { folderId: { notIn: ['secret-folder'] } }] });
  });
});
