import { getPrisma, type StorageProvider } from '@cdn/database';
import { createStorageDriver, type StorageConfig, type StorageDriver, type StorageKind } from '@cdn/storage';
import { decryptJson, encryptJson, newId } from '@cdn/shared';
import { z } from 'zod';
import path from 'node:path';
import { env, getKeyring } from '../config/env.js';
import { AppError } from '@cdn/shared';

/**
 * Storage providers live in the database with their configuration (including credentials)
 * encrypted with AES-256-GCM, bound to the provider id via AAD. The provider created from
 * environment variables stores only a `{ fromEnv: true }` marker so env secrets are never
 * copied into the database.
 */

export const ProviderConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LOCAL'), root: z.string().min(1).max(500) }),
  z.object({
    kind: z.enum(['S3', 'R2', 'MINIO', 'B2']),
    endpoint: z.string().url().optional().or(z.literal('')),
    region: z.string().max(64).default('auto'),
    bucket: z.string().min(3).max(63),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
    forcePathStyle: z.boolean().optional(),
    prefix: z.string().max(200).optional(),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

type StoredConfig = ProviderConfig | { fromEnv: true };

const drivers = new Map<string, { updatedAt: number; driver: StorageDriver }>();

function aad(id: string): string {
  return `storage_provider:${id}`;
}

export function encryptProviderConfig(id: string, config: StoredConfig): string {
  return encryptJson(getKeyring(), config, aad(id));
}

function envStorageConfig(): StorageConfig {
  const e = env();
  if (e.STORAGE_DRIVER === 'LOCAL') return { kind: 'LOCAL', config: { root: path.resolve(e.LOCAL_STORAGE_PATH) } };
  return {
    kind: e.STORAGE_DRIVER,
    config: {
      endpoint: e.S3_ENDPOINT || undefined,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET!,
      accessKeyId: e.S3_ACCESS_KEY_ID!,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: e.S3_FORCE_PATH_STYLE || undefined,
      prefix: e.S3_PREFIX || undefined,
    },
  };
}

export function toStorageConfig(config: ProviderConfig): StorageConfig {
  if (config.kind === 'LOCAL') return { kind: 'LOCAL', config: { root: path.resolve(config.root) } };
  return {
    kind: config.kind,
    config: {
      endpoint: config.endpoint || undefined,
      region: config.region || 'auto',
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      prefix: config.prefix,
    },
  };
}

export function publicInfoFor(config: ProviderConfig | StorageConfig): Record<string, string> {
  if ('config' in config) {
    return config.kind === 'LOCAL'
      ? { root: config.config.root }
      : { bucket: config.config.bucket, endpoint: config.config.endpoint ?? '', region: config.config.region };
  }
  return config.kind === 'LOCAL' ? { root: config.root } : { bucket: config.bucket, endpoint: config.endpoint ?? '', region: config.region };
}

function buildDriver(provider: StorageProvider): StorageDriver {
  const stored = decryptJson<StoredConfig>(getKeyring(), provider.configEnc, aad(provider.id));
  if ('fromEnv' in stored) return createStorageDriver(envStorageConfig());
  return createStorageDriver(toStorageConfig(stored));
}

export function driverFor(provider: StorageProvider): StorageDriver {
  const cached = drivers.get(provider.id);
  if (cached && cached.updatedAt === provider.updatedAt.getTime()) return cached.driver;
  const driver = buildDriver(provider);
  drivers.set(provider.id, { updatedAt: provider.updatedAt.getTime(), driver });
  return driver;
}

export async function driverForId(providerId: string): Promise<{ provider: StorageProvider; driver: StorageDriver }> {
  const provider = await getPrisma().storageProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw new AppError('storage_provider_not_found');
  return { provider, driver: driverFor(provider) };
}

/** Ensures a default provider exists (created from the environment on first boot). */
export async function ensureDefaultProvider(): Promise<StorageProvider> {
  const prisma = getPrisma();
  const existing = await prisma.storageProvider.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  const cfg = envStorageConfig();
  const id = newId('storageProvider');
  return prisma.storageProvider.create({
    data: {
      id,
      name: 'Primary (environment)',
      kind: cfg.kind as StorageKind,
      configEnc: encryptProviderConfig(id, { fromEnv: true }),
      publicInfo: { ...publicInfoFor(cfg), source: 'environment' },
      isDefault: true,
    },
  });
}

/** Provider for new uploads: the one selected in settings, else the default. */
export async function uploadProvider(preferredId: string | null): Promise<StorageProvider> {
  const prisma = getPrisma();
  if (preferredId) {
    const p = await prisma.storageProvider.findFirst({ where: { id: preferredId, enabled: true } });
    if (p) return p;
  }
  return ensureDefaultProvider();
}

export function forgetDriver(providerId: string): void {
  drivers.delete(providerId);
}
