import { LocalStorageDriver, type LocalStorageConfig } from './local.js';
import { S3StorageDriver, type S3StorageConfig } from './s3.js';
import { StorageError, type StorageDriver, type StorageKind } from './types.js';

export * from './types.js';
export * from './keys.js';
export { LocalStorageDriver, S3StorageDriver };
export type { LocalStorageConfig, S3StorageConfig };

export type StorageConfig =
  | { kind: 'LOCAL'; config: LocalStorageConfig }
  | { kind: Exclude<StorageKind, 'LOCAL'>; config: Omit<S3StorageConfig, 'kind'> };

export const STORAGE_KINDS: StorageKind[] = ['LOCAL', 'S3', 'R2', 'MINIO', 'B2'];

export function createStorageDriver(cfg: StorageConfig): StorageDriver {
  switch (cfg.kind) {
    case 'LOCAL':
      return new LocalStorageDriver(cfg.config);
    case 'S3':
    case 'R2':
    case 'MINIO':
    case 'B2':
      return new S3StorageDriver({ ...cfg.config, kind: cfg.kind });
    default:
      throw new StorageError(`Unsupported storage kind ${(cfg as { kind: string }).kind}`);
  }
}
