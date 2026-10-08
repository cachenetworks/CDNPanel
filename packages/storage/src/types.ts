import type { Readable } from 'node:stream';

export type StorageKind = 'LOCAL' | 'S3' | 'R2' | 'MINIO' | 'B2' | 'NODE' | 'POOL';

export interface ByteRange {
  /** inclusive */
  start: number;
  /** inclusive */
  end: number;
}

export interface PutOptions {
  contentType: string;
  /** Known content length, if available (enables single-request uploads to S3). */
  size?: number;
}

export interface ObjectInfo {
  size: number;
  lastModified?: Date;
}

export interface PresignOptions {
  expiresIn: number;
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
}

export interface CapacityInfo {
  /** Bytes free on the backing volume, if knowable. */
  available: number | null;
  /** Total size of the backing volume, if knowable. */
  total: number | null;
}

export interface StorageDriver {
  readonly kind: StorageKind;
  put(key: string, body: Readable | Buffer, opts: PutOptions): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  copy(sourceKey: string, destKey: string): Promise<void>;
  /** Verifies the backend is reachable and writable. Throws on failure. */
  healthCheck(): Promise<void>;
  capacity(): Promise<CapacityInfo>;
  /** Object-storage presigned GET URL, if the backend supports it. */
  presignGet?(key: string, opts: PresignOptions): Promise<string>;
  /** Absolute path on disk (local driver only) — used for Nginx X-Accel-Redirect. */
  resolvePath?(key: string): string;
  /** Every object key under `prefix`, in no particular order (local, node and pool drivers). */
  listKeys?(prefix?: string): AsyncIterable<string>;
}

export class StorageError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export class StorageKeyError extends StorageError {}
