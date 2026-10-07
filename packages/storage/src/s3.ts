import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertSafeKey } from './keys.js';
import {
  StorageError,
  type ByteRange,
  type CapacityInfo,
  type ObjectInfo,
  type PresignOptions,
  type PutOptions,
  type StorageDriver,
  type StorageKind,
} from './types.js';

export interface S3StorageConfig {
  kind?: Exclude<StorageKind, 'LOCAL'>;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required by MinIO and most self-hosted gateways. */
  forcePathStyle?: boolean;
  /** Optional key prefix inside the bucket, e.g. `cdn/` */
  prefix?: string;
}

/**
 * S3-compatible driver: AWS S3, Cloudflare R2, MinIO, Backblaze B2 (S3 API) and others.
 */
export class S3StorageDriver implements StorageDriver {
  readonly kind: Exclude<StorageKind, 'LOCAL'>;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3StorageConfig) {
    if (!config.bucket) throw new StorageError('S3 bucket is required');
    this.kind = config.kind ?? 'S3';
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (this.prefix) assertSafeKey(this.prefix);
    this.client = new S3Client({
      region: config.region || 'auto',
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle ?? this.kind === 'MINIO',
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  private fullKey(key: string): string {
    assertSafeKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, body: Readable | Buffer, opts: PutOptions): Promise<void> {
    try {
      if (Buffer.isBuffer(body)) {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key), Body: body, ContentType: opts.contentType, ContentLength: body.length }),
        );
        return;
      }
      // Multipart streaming upload: does not buffer the whole object in memory.
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: this.fullKey(key), Body: body, ContentType: opts.contentType },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    } catch (err) {
      throw new StorageError('Failed to write object to S3', err);
    }
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
      );
      if (!res.Body) throw new StorageError('Empty S3 response body');
      return res.Body as Readable;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('Failed to read object from S3', err);
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
      return { size: Number(res.ContentLength ?? 0), lastModified: res.LastModified };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw new StorageError('Failed to stat object in S3', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
    } catch (err) {
      throw new StorageError('Failed to delete object from S3', err);
    }
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    try {
      const source = `${this.bucket}/${this.fullKey(sourceKey)}`.split('/').map(encodeURIComponent).join('/');
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: this.fullKey(destKey), CopySource: source }));
    } catch (err) {
      throw new StorageError('Failed to copy object in S3', err);
    }
  }

  async healthCheck(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      throw new StorageError('S3 bucket is not reachable', err);
    }
  }

  async capacity(): Promise<CapacityInfo> {
    // Object storage has no fixed capacity; quotas are enforced by the platform settings.
    return { available: null, total: null };
  }

  async presignGet(key: string, opts: PresignOptions): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.contentDisposition,
        ResponseCacheControl: opts.cacheControl,
      }),
      { expiresIn: Math.max(1, Math.min(opts.expiresIn, 7 * 24 * 3600)) },
    );
  }
}
