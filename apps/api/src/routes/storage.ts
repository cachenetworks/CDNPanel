import path from 'node:path';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPrisma } from '@cdn/database';
import { createStorageDriver } from '@cdn/storage';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { serializeFile, FILE_INCLUDE } from '../lib/serialize.js';
import {
  ProviderConfigSchema,
  driverFor,
  encryptProviderConfig,
  ensureDefaultProvider,
  forgetDriver,
  publicInfoFor,
  toStorageConfig,
  type ProviderConfig,
} from '../lib/storageRegistry.js';
import { getSettings } from '../lib/settings.js';
import { providerSpace, smallestKnownLimit } from '../services/storageCapacity.js';

const providerParams = z.object({ id: z.string().refine((v) => isValidId('storageProvider', v), 'invalid provider id') });

/** Placement and cost fields used by replication (NEAREST / FAILOVER) and usage cost estimates. */
const placement = {
  region: z.string().trim().max(60).optional(),
  serves_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  cost_storage_per_gb_month: z.number().min(0).max(1000).optional(),
  cost_egress_per_gb: z.number().min(0).max(1000).optional(),
  cost_per_million_requests: z.number().min(0).max(1000).optional(),
};

function placementData(body: { region?: string; serves_countries?: string[]; priority?: number; cost_storage_per_gb_month?: number; cost_egress_per_gb?: number; cost_per_million_requests?: number }) {
  return {
    ...(body.region !== undefined ? { region: body.region } : {}),
    ...(body.serves_countries !== undefined ? { servesCountries: [...new Set(body.serves_countries)] } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    ...(body.cost_storage_per_gb_month !== undefined ? { costStoragePerGbMonth: body.cost_storage_per_gb_month } : {}),
    ...(body.cost_egress_per_gb !== undefined ? { costEgressPerGb: body.cost_egress_per_gb } : {}),
    ...(body.cost_per_million_requests !== undefined ? { costPerMillionRequests: body.cost_per_million_requests } : {}),
  };
}

async function testConfig(config: ProviderConfig): Promise<void> {
  if (config.kind === 'LOCAL') {
    // Local providers may only live beneath the configured base directory.
    const base = path.resolve(env().LOCAL_STORAGE_ALLOWED_ROOT ?? path.dirname(path.resolve(env().LOCAL_STORAGE_PATH)));
    const root = path.resolve(base, config.root);
    const rel = path.relative(base, root);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new AppError('validation_failed', `Local storage roots must be inside ${base}.`);
    }
    config.root = root;
  }
  try {
    await createStorageDriver(toStorageConfig(config)).healthCheck();
  } catch (err) {
    throw new AppError('validation_failed', `Could not connect to the storage backend: ${(err as Error).message.slice(0, 200)}`);
  }
}

async function providerSummaries() {
  const prisma = getPrisma();
  await ensureDefaultProvider();
  const providers = await prisma.storageProvider.findMany({ orderBy: { createdAt: 'asc' } });
  const usage = await prisma.file.groupBy({ by: ['storageProviderId'], _sum: { size: true }, _count: { _all: true } });
  return Promise.all(
    providers.map(async (p) => {
      const u = usage.find((x) => x.storageProviderId === p.id);
      const used = Number(u?._sum.size ?? 0);
      const cap = await providerSpace(p, used);
      return {
        id: p.id,
        object: 'storage_provider' as const,
        name: p.name,
        kind: p.kind,
        is_default: p.isDefault,
        enabled: p.enabled,
        public_info: p.publicInfo,
        capacity: cap.capacity,
        available: cap.available,
        disk_total: cap.disk_total,
        disk_free: cap.disk_free,
        disk_used: cap.disk_used,
        disk_other_used_estimate: cap.disk_other_used_estimate,
        configured_capacity: cap.configured_capacity,
        used,
        file_count: u?._count._all ?? 0,
        region: p.region,
        serves_countries: p.servesCountries,
        priority: p.priority,
        cost_storage_per_gb_month: p.costStoragePerGbMonth,
        cost_egress_per_gb: p.costEgressPerGb,
        cost_per_million_requests: p.costPerMillionRequests,
        health_status: p.healthStatus,
        health_checked_at: p.healthCheckedAt?.toISOString() ?? null,
        latency_ms: p.latencyMs,
        created_at: p.createdAt.toISOString(),
        updated_at: p.updatedAt.toISOString(),
      };
    }),
  );
}

export const storageRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/storage',
    tag: 'Storage',
    summary: 'Storage statistics',
    description: 'Storage used / available, file count, average size, largest files, type distribution and per-provider usage.',
    auth: 'session',
    permission: 'files.view',
    responses: { 200: { description: 'Storage statistics' } },
    async handler() {
      const prisma = getPrisma();
      const settings = await getSettings();
      const [agg, largest, byType, providers] = await Promise.all([
        prisma.file.aggregate({ _sum: { size: true }, _count: { _all: true }, _avg: { size: true } }),
        prisma.file.findMany({ orderBy: { size: 'desc' }, take: 10, include: FILE_INCLUDE }),
        prisma.$queryRaw<{ type: string; count: bigint; bytes: bigint }[]>`SELECT split_part("mimeType", '/', 1) AS type, count(*) AS count, coalesce(sum("size"),0) AS bytes FROM "File" GROUP BY 1 ORDER BY bytes DESC`,
        providerSummaries(),
      ]);
      const def = providers.find((p) => p.is_default);
      const used = Number(agg._sum.size ?? 0);
      const quotaRemaining = settings.uploads.quotaBytes === null ? null : Math.max(0, settings.uploads.quotaBytes - used);
      const available = smallestKnownLimit(quotaRemaining, def?.available);
      return {
        used,
        quota: settings.uploads.quotaBytes,
        available,
        // Effective CDN ceiling from current usage + headroom. A disk might
        // already contain unrelated data, so its full size is not CDN capacity.
        capacity: available === null ? null : used + available,
        disk_total: def?.disk_total ?? null,
        disk_free: def?.disk_free ?? null,
        disk_used: def?.disk_used ?? null,
        disk_other_used_estimate: def?.disk_other_used_estimate ?? null,
        file_count: agg._count._all,
        average_file_size: Math.round(Number(agg._avg.size ?? 0)),
        largest_files: largest.map(serializeFile),
        by_type: byType.map((t) => ({ type: t.type, count: Number(t.count), bytes: Number(t.bytes) })),
        providers,
        default_backend: def ? { id: def.id, name: def.name, kind: def.kind } : null,
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/storage/providers',
    tag: 'Storage',
    summary: 'List storage providers',
    description: 'Credentials are stored encrypted (AES-256-GCM) and are never returned.',
    auth: 'session',
    permission: 'storage.manage',
    responses: { 200: { description: 'Providers' } },
    async handler() {
      return { data: await providerSummaries() };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/providers',
    tag: 'Storage',
    summary: 'Add a storage provider',
    description: 'Adds a LOCAL, S3, R2, MINIO or B2 provider. The connection is tested before saving. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    body: z.object({ name: z.string().trim().min(1).max(100), config: ProviderConfigSchema, capacity: z.number().int().positive().nullable().optional(), ...placement }),
    responses: { 201: { description: 'Created provider' } },
    errors: ['validation_failed', 'conflict', 'reauthentication_required'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      if (await prisma.storageProvider.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A provider with this name already exists.');
      await testConfig(body.config);
      const id = newId('storageProvider');
      await prisma.storageProvider.create({
        data: {
          id,
          name: body.name,
          kind: body.config.kind,
          configEnc: encryptProviderConfig(id, body.config),
          publicInfo: publicInfoFor(body.config),
          capacity: body.capacity ? BigInt(body.capacity) : null,
          ...placementData(body),
        },
      });
      await audit(actorOf(req), 'STORAGE_PROVIDER_CREATED', { type: 'storage_provider', id }, { name: body.name, kind: body.config.kind, ...publicInfoFor(body.config) });
      reply.code(201);
      return (await providerSummaries()).find((p) => p.id === id);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/storage/providers/:id',
    tag: 'Storage',
    summary: 'Update a storage provider',
    description: 'Rename, enable/disable, change capacity, make default, or replace the configuration (re-tested). Existing files stay on the provider they were uploaded to. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: providerParams,
    body: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        is_default: z.literal(true).optional(),
        capacity: z.number().int().positive().nullable().optional(),
        config: ProviderConfigSchema.optional(),
        ...placement,
      })
      .strict(),
    responses: { 200: { description: 'Updated provider' } },
    errors: ['storage_provider_not_found', 'validation_failed', 'conflict'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const p = await prisma.storageProvider.findUnique({ where: { id: params.id } });
      if (!p) throw new AppError('storage_provider_not_found');
      if (body.config) {
        if (p.kind === 'POOL') throw new AppError('validation_failed', 'RAID pool members are managed under Storage → Nodes & RAID.');
        if (body.config.kind !== p.kind) throw new AppError('validation_failed', 'The provider kind cannot be changed.');
        await testConfig(body.config);
      }
      if (body.enabled === false && (p.isDefault || body.is_default)) throw new AppError('conflict', 'The default provider cannot be disabled.');
      await prisma.$transaction(async (tx) => {
        if (body.is_default) await tx.storageProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        await tx.storageProvider.update({
          where: { id: p.id },
          data: {
            ...(body.name ? { name: body.name } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.is_default ? { isDefault: true, enabled: true } : {}),
            ...(body.capacity !== undefined ? { capacity: body.capacity ? BigInt(body.capacity) : null } : {}),
            ...(body.config ? { configEnc: encryptProviderConfig(p.id, body.config), publicInfo: publicInfoFor(body.config) } : {}),
            ...placementData(body),
          },
        });
      });
      forgetDriver(p.id);
      await audit(actorOf(req), 'STORAGE_PROVIDER_UPDATED', { type: 'storage_provider', id: p.id }, {
        name: body.name,
        enabled: body.enabled,
        is_default: body.is_default,
        config_replaced: Boolean(body.config),
      });
      return (await providerSummaries()).find((x) => x.id === p.id);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/storage/providers/:id/test',
    tag: 'Storage',
    summary: 'Test a storage provider',
    auth: 'session',
    permission: 'storage.manage',
    params: providerParams,
    responses: { 200: { description: 'Result', example: { ok: true } } },
    errors: ['storage_provider_not_found'],
    async handler({ params }) {
      const p = await getPrisma().storageProvider.findUnique({ where: { id: params.id } });
      if (!p) throw new AppError('storage_provider_not_found');
      try {
        await driverFor(p).healthCheck();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message.slice(0, 200) };
      }
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/storage/providers/:id',
    tag: 'Storage',
    summary: 'Remove a storage provider',
    description: 'Only providers that hold no files and are not the default can be removed. Requires re-authentication.',
    auth: 'session',
    permission: 'storage.manage',
    requireReauth: true,
    params: providerParams,
    responses: { 204: { description: 'Removed' } },
    errors: ['storage_provider_not_found', 'conflict'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const p = await prisma.storageProvider.findUnique({ where: { id: params.id } });
      if (!p) throw new AppError('storage_provider_not_found');
      if (p.isDefault) throw new AppError('conflict', 'The default provider cannot be removed.');
      if (p.kind === 'POOL') throw new AppError('conflict', 'This provider is a RAID pool. Remove it under Storage → Nodes & RAID.');
      const [files, uploads] = await Promise.all([prisma.file.count({ where: { storageProviderId: p.id } }), prisma.upload.count({ where: { storageProviderId: p.id } })]);
      if (files > 0) throw new AppError('conflict', `The provider still holds ${files} file(s).`);
      if (uploads > 0) await prisma.upload.deleteMany({ where: { storageProviderId: p.id } });
      await prisma.storageProvider.delete({ where: { id: p.id } });
      forgetDriver(p.id);
      await audit(actorOf(req), 'STORAGE_PROVIDER_DELETED', { type: 'storage_provider', id: p.id }, { name: p.name });
    },
  }),
];
