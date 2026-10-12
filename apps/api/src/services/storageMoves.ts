import type { FastifyRequest } from 'fastify';
import type { Job } from 'bullmq';
import { getPrisma, type Prisma } from '@cdn/database';
import { AppError } from '@cdn/shared';
import { hiddenFolderIds, canAccessChain, getFolderChain } from '../lib/folders.js';
import { audit } from '../lib/audit.js';
import type { StorageMoveJob } from '../lib/queue.js';
import { moveFileStorage } from './lifecycle.js';

export interface StorageMoveProgress {
  total: number;
  processed: number;
  moved: number;
  failed: number;
  skipped: number;
  current_file: string | null;
  failures: { id: string; name: string; error: string }[];
}

export function initialMoveProgress(total: number): StorageMoveProgress {
  return { total, processed: 0, moved: 0, failed: 0, skipped: 0, current_file: null, failures: [] };
}

export async function localMoveScope(req: FastifyRequest): Promise<Prisma.FileWhereInput> {
  const hidden = await hiddenFolderIds(req);
  return {
    storageProvider: { kind: 'LOCAL' },
    deletedAt: null,
    ...(hidden.length ? { OR: [{ folderId: null }, { folderId: { notIn: hidden } }] } : {}),
  };
}

/** A resumable background move. Snapshot ids exclude uploads made after the request. */
export async function runStorageMove(job: Job<StorageMoveJob>): Promise<StorageMoveProgress> {
  const prisma = getPrisma();
  const data = job.data;
  const saved = job.progress;
  const progress: StorageMoveProgress = typeof saved === 'object' && 'processed' in saved
    ? structuredClone(saved) as StorageMoveProgress : initialMoveProgress(data.fileIds.length);
  const user = await prisma.user.findUnique({ where: { id: data.userId }, include: { roles: { include: { role: { include: { permissions: true } } } } } });
  const permissions = new Set(user?.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)));
  if (!user || user.status !== 'ACTIVE' || !permissions.has('files.edit') || !permissions.has('storage.manage')) {
    throw new AppError('forbidden', 'The user who started this move no longer has access.');
  }
  const accessRequest = { auth: { type: 'session', roleIds: user.roles.map((r) => r.roleId), permissions } } as FastifyRequest;
  for (let index = progress.processed; index < data.fileIds.length; index++) {
    const id = data.fileIds[index]!;
    const file = await prisma.file.findUnique({ where: { id } });
    progress.current_file = file?.name ?? id;
    await job.updateProgress(progress);
    try {
      if (!file || file.deletedAt || file.status !== 'READY') progress.skipped++;
      else {
        if (file.folderId) {
          const folder = await prisma.folder.findUnique({ where: { id: file.folderId } });
          if (folder && !canAccessChain(accessRequest, await getFolderChain(folder))) throw new AppError('forbidden');
        }
        if (file.storageProviderId === data.targetProviderId) {
          // The move committed before a worker restart saved its checkpoint.
          progress.moved++;
        } else if (!data.sourceProviderIds.includes(file.storageProviderId)) progress.skipped++;
        else {
          await moveFileStorage(file, data.targetProviderId, 'standard');
          progress.moved++;
          await audit({ actorType: 'user', actorId: data.userId }, 'FILE_MOVE', { type: 'file', id }, {
            from_storage_provider: file.storageProviderId, to_storage_provider: data.targetProviderId, job_id: job.id,
          });
        }
      }
    } catch (err) {
      progress.failed++;
      if (progress.failures.length < 100) progress.failures.push({ id, name: file?.name ?? id, error: (err as Error).message.slice(0, 300) });
    }
    progress.processed = index + 1;
    await job.updateProgress(progress);
  }
  progress.current_file = null;
  await job.updateProgress(progress);
  return progress;
}
