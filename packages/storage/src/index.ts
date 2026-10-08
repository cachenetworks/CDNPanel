import { LocalStorageDriver, type LocalStorageConfig } from './local.js';
import { NodeStorageDriver, type NodeStorageConfig } from './node.js';
import { RaidStorageDriver, type RaidLevel } from './raid.js';
import { S3StorageDriver, type S3StorageConfig } from './s3.js';
import { StorageError, type StorageDriver, type StorageKind } from './types.js';

export * from './types.js';
export * from './keys.js';
export * from './raid.js';
export { LocalStorageDriver, NodeStorageDriver, S3StorageDriver };
export type { LocalStorageConfig, NodeStorageConfig, S3StorageConfig };
export type { NodeStatus } from './node.js';

/** A pool member: a remote storage node or a directory on this server. */
export type PoolMemberConfig =
  | { id: string; kind: 'REMOTE'; url: string; token: string; offline?: boolean }
  | { id: string; kind: 'LOCAL'; root: string; offline?: boolean };

export interface PoolConfig {
  level: RaidLevel;
  chunkSize?: number;
  members: PoolMemberConfig[];
}

export type StorageConfig =
  | { kind: 'LOCAL'; config: LocalStorageConfig }
  | { kind: 'NODE'; config: NodeStorageConfig }
  | { kind: 'POOL'; config: PoolConfig }
  | { kind: Exclude<StorageKind, 'LOCAL' | 'NODE' | 'POOL'>; config: Omit<S3StorageConfig, 'kind'> };

/** Kinds that can be configured directly as a provider (nodes and pools are managed separately). */
export const STORAGE_KINDS: StorageKind[] = ['LOCAL', 'S3', 'R2', 'MINIO', 'B2'];

export function memberDriver(m: PoolMemberConfig): StorageDriver {
  return m.kind === 'REMOTE' ? new NodeStorageDriver({ url: m.url, token: m.token }) : new LocalStorageDriver({ root: m.root });
}

export function createStorageDriver(cfg: StorageConfig): StorageDriver {
  switch (cfg.kind) {
    case 'LOCAL':
      return new LocalStorageDriver(cfg.config);
    case 'NODE':
      return new NodeStorageDriver(cfg.config);
    case 'POOL':
      return new RaidStorageDriver({
        level: cfg.config.level,
        chunkSize: cfg.config.chunkSize,
        members: cfg.config.members.map((m) => ({ id: m.id, offline: m.offline, driver: memberDriver(m) })),
      });
    case 'S3':
    case 'R2':
    case 'MINIO':
    case 'B2':
      return new S3StorageDriver({ ...cfg.config, kind: cfg.kind });
    default:
      throw new StorageError(`Unsupported storage kind ${(cfg as { kind: string }).kind}`);
  }
}
