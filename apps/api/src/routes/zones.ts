import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getPrisma, Prisma, type CacheRule, type Project, type Zone, type ZoneDomain } from '@cdn/database';
import { AppError, encryptField, isValidId, newId, randomToken, slugifySegment } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf } from '../http/context.js';
import { getKeyring } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { cloudflareConfigFor, cloudflareTokenAad, verifyCloudflareToken } from '../lib/cloudflare.js';
import { requireFolder } from '../lib/folders.js';
import { invalidateZones } from '../lib/zones.js';
import { challengeRecordName, cnameTarget, inspectDns, probeDomain, validateHostname, verifyDomain } from '../services/domains.js';
import { triggerZoneReplication } from '../services/replication.js';

const visibility = z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']);
const country = z.string().regex(/^[A-Z]{2}$/, 'use ISO 3166-1 alpha-2 country codes');
const idParam = (kind: 'project' | 'zone' | 'domain' | 'cacheRule') => z.object({ id: z.string().refine((v) => isValidId(kind, v), `invalid ${kind} id`) });

// ─── Serialization ──────────────────────────────────────────────────────────

export function serializeProject(p: Project & { _count?: { zones: number; apiKeys: number } }) {
  return {
    id: p.id,
    object: 'project' as const,
    name: p.name,
    slug: p.slug,
    description: p.description,
    zone_count: p._count?.zones,
    api_key_count: p._count?.apiKeys,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export function serializeDomain(d: ZoneDomain) {
  return {
    id: d.id,
    object: 'domain' as const,
    zone_id: d.zoneId,
    hostname: d.hostname,
    status: d.status,
    is_primary: d.isPrimary,
    tls_status: d.tlsStatus,
    health_status: d.healthStatus,
    verified_at: d.verifiedAt?.toISOString() ?? null,
    last_checked_at: d.lastCheckedAt?.toISOString() ?? null,
    last_error: d.lastError,
    verification: {
      txt: { name: challengeRecordName(d.hostname), value: d.verificationToken },
      cname: { name: d.hostname, target: cnameTarget() },
    },
    created_at: d.createdAt.toISOString(),
  };
}

export function serializeCacheRule(r: CacheRule) {
  return {
    id: r.id,
    object: 'cache_rule' as const,
    zone_id: r.zoneId,
    name: r.name,
    pattern: r.pattern,
    edge_ttl: r.edgeTtl,
    browser_ttl: r.browserTtl,
    bypass: r.bypass,
    priority: r.priority,
    enabled: r.enabled,
    created_at: r.createdAt.toISOString(),
  };
}

type ZoneFull = Zone & { domains?: ZoneDomain[]; cacheRules?: CacheRule[]; rootFolder?: { id: string; path: string } | null; project?: Project };

export function serializeZone(z: ZoneFull) {
  return {
    id: z.id,
    object: 'zone' as const,
    project_id: z.projectId,
    project: z.project ? { id: z.project.id, name: z.project.name, slug: z.project.slug } : undefined,
    name: z.name,
    slug: z.slug,
    enabled: z.enabled,
    root_folder: z.rootFolder ? { id: z.rootFolder.id, path: z.rootFolder.path } : null,
    storage_provider_id: z.storageProviderId,
    allowed_mime_types: z.allowedMimeTypes,
    max_file_size: z.maxFileSize === null ? null : Number(z.maxFileSize),
    default_visibility: z.defaultVisibility,
    edge_ttl: z.edgeTtl,
    browser_ttl: z.browserTtl,
    image_optimization: z.imageOptimization,
    require_signed_transforms: z.requireSignedTransforms,
    video_processing: z.videoProcessing,
    allowed_referrers: z.allowedReferrers,
    allow_empty_referrer: z.allowEmptyReferrer,
    allowed_countries: z.allowedCountries,
    blocked_countries: z.blockedCountries,
    blocked_asns: z.blockedAsns,
    replication_strategy: z.replicationStrategy,
    replica_provider_ids: z.replicaProviderIds,
    cloudflare: { zone_id: z.cloudflareZoneId, token_configured: Boolean(z.cloudflareTokenEnc) },
    domains: z.domains?.map(serializeDomain),
    cache_rules: z.cacheRules?.map(serializeCacheRule),
    created_at: z.createdAt.toISOString(),
    updated_at: z.updatedAt.toISOString(),
  };
}

const ZONE_INCLUDE = {
  domains: { orderBy: { createdAt: 'asc' } },
  cacheRules: { orderBy: { priority: 'asc' } },
  rootFolder: { select: { id: true, path: true } },
  project: true,
} satisfies Prisma.ZoneInclude;

// ─── Access helpers ─────────────────────────────────────────────────────────

/** Project-bound API keys only see their own project. */
function projectScope(req: FastifyRequest): string | null {
  return req.auth?.type === 'api_key' ? req.auth.apiKey.projectId : null;
}

async function requireProject(req: FastifyRequest, id: string): Promise<Project> {
  const p = await getPrisma().project.findUnique({ where: { id } });
  const scope = projectScope(req);
  if (!p || (scope && scope !== p.id)) throw new AppError('project_not_found');
  return p;
}

export async function requireZone(req: FastifyRequest, id: string) {
  if (!isValidId('zone', id)) throw new AppError('invalid_id', 'The zone id is malformed.');
  const zone = await getPrisma().zone.findUnique({ where: { id }, include: ZONE_INCLUDE });
  const scope = projectScope(req);
  if (!zone || (scope && scope !== zone.projectId)) throw new AppError('zone_not_found');
  return zone;
}

async function requireDomain(req: FastifyRequest, id: string): Promise<ZoneDomain> {
  const d = await getPrisma().zoneDomain.findUnique({ where: { id } });
  if (!d) throw new AppError('domain_not_found');
  await requireZone(req, d.zoneId);
  return d;
}

async function uniqueSlug(base: string, table: 'project' | 'zone', excludeId?: string): Promise<string> {
  const root = slugifySegment(base).replace(/\./g, '-').slice(0, 48) || table;
  const prisma = getPrisma();
  for (let i = 0; i < 1000; i++) {
    const slug = i === 0 ? root : `${root}-${i}`;
    const exists = table === 'project' ? await prisma.project.findFirst({ where: { slug, NOT: excludeId ? { id: excludeId } : undefined } }) : await prisma.zone.findFirst({ where: { slug, NOT: excludeId ? { id: excludeId } : undefined } });
    if (!exists) return slug;
  }
  return `${root}-${randomToken(3)}`;
}

async function validateProviders(ids: (string | null | undefined)[]): Promise<void> {
  const list = ids.filter((x): x is string => Boolean(x));
  if (list.length === 0) return;
  const found = await getPrisma().storageProvider.count({ where: { id: { in: list } } });
  if (found !== new Set(list).size) throw new AppError('storage_provider_not_found');
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const zoneConfig = {
  storage_provider_id: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  allowed_mime_types: z.array(z.string().min(1).max(100)).max(100).optional(),
  max_file_size: z.number().int().positive().nullable().optional(),
  default_visibility: visibility.nullable().optional(),
  edge_ttl: z.number().int().min(0).max(31_536_000).optional(),
  browser_ttl: z.number().int().min(0).max(31_536_000).optional(),
  image_optimization: z.boolean().optional(),
  require_signed_transforms: z.boolean().optional(),
  video_processing: z.boolean().optional(),
  allowed_referrers: z.array(z.string().min(1).max(253)).max(100).optional(),
  allow_empty_referrer: z.boolean().optional(),
  allowed_countries: z.array(country).max(250).optional(),
  blocked_countries: z.array(country).max(250).optional(),
  blocked_asns: z.array(z.number().int().positive()).max(500).optional(),
  replication_strategy: z.enum(['PRIMARY_ONLY', 'MIRROR', 'NEAREST', 'FAILOVER']).optional(),
  replica_provider_ids: z.array(z.string()).max(10).optional(),
};

function zoneData(body: Partial<Record<keyof typeof zoneConfig, unknown>>): Prisma.ZoneUncheckedUpdateInput {
  const map: Record<string, string> = {
    storage_provider_id: 'storageProviderId',
    enabled: 'enabled',
    allowed_mime_types: 'allowedMimeTypes',
    default_visibility: 'defaultVisibility',
    edge_ttl: 'edgeTtl',
    browser_ttl: 'browserTtl',
    image_optimization: 'imageOptimization',
    require_signed_transforms: 'requireSignedTransforms',
    video_processing: 'videoProcessing',
    allowed_referrers: 'allowedReferrers',
    allow_empty_referrer: 'allowEmptyReferrer',
    allowed_countries: 'allowedCountries',
    blocked_countries: 'blockedCountries',
    blocked_asns: 'blockedAsns',
    replication_strategy: 'replicationStrategy',
    replica_provider_ids: 'replicaProviderIds',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined && map[k]) out[map[k]] = v;
  if (body.max_file_size !== undefined) out.maxFileSize = body.max_file_size === null ? null : BigInt(body.max_file_size as number);
  return out as Prisma.ZoneUncheckedUpdateInput;
}

const ZONE_EXAMPLE = {
  id: 'zon_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'zone',
  project_id: 'prj_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  name: 'Sentinel assets',
  slug: 'sentinel-assets',
  enabled: true,
  root_folder: { id: 'fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', path: '/sentinel' },
  edge_ttl: 31536000,
  browser_ttl: 86400,
  replication_strategy: 'FAILOVER',
  domains: [{ id: 'dom_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', hostname: 'assets.sentinelbot.dev', status: 'ACTIVE', tls_status: 'active', health_status: 'healthy' }],
};

export const zoneRoutes: RouteDef<any, any, any>[] = [
  // ─── Projects ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/projects',
    tag: 'Zones',
    summary: 'List projects',
    auth: 'any',
    permission: 'zones.view',
    scope: 'zones:read',
    responses: { 200: { description: 'Projects' } },
    async handler({ req }) {
      const scope = projectScope(req);
      const rows = await getPrisma().project.findMany({ where: scope ? { id: scope } : {}, include: { _count: { select: { zones: true, apiKeys: true } } }, orderBy: { name: 'asc' } });
      return { data: rows.map(serializeProject) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/projects',
    tag: 'Zones',
    summary: 'Create a project',
    auth: 'session',
    permission: 'zones.manage',
    body: z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default('') }),
    responses: { 201: { description: 'Created project' } },
    errors: ['conflict'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      if (await prisma.project.findUnique({ where: { name: body.name } })) throw new AppError('conflict', 'A project with that name already exists.');
      const project = await prisma.project.create({
        data: { id: newId('project'), name: body.name, slug: await uniqueSlug(body.name, 'project'), description: body.description, createdById: req.auth?.type === 'session' ? req.auth.user.id : null },
      });
      await audit(actorOf(req), 'PROJECT_CREATE', { type: 'project', id: project.id }, { name: body.name });
      reply.code(201);
      return serializeProject(project);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/projects/:id',
    tag: 'Zones',
    summary: 'Update a project',
    auth: 'session',
    permission: 'zones.manage',
    params: idParam('project'),
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).optional() }).strict(),
    errors: ['project_not_found', 'conflict'],
    async handler({ req, params, body }) {
      await requireProject(req, params.id);
      try {
        const p = await getPrisma().project.update({ where: { id: params.id }, data: body });
        await audit(actorOf(req), 'PROJECT_UPDATE', { type: 'project', id: p.id }, { changes: body });
        return serializeProject(p);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError('conflict', 'A project with that name already exists.');
        throw err;
      }
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/projects/:id',
    tag: 'Zones',
    summary: 'Delete a project',
    description: 'Only empty projects (no zones) can be deleted. API keys and service accounts bound to the project are unbound; project webhooks are deleted.',
    auth: 'session',
    permission: 'zones.manage',
    requireReauth: true,
    params: idParam('project'),
    errors: ['project_not_found', 'conflict', 'reauthentication_required'],
    async handler({ req, params }) {
      const p = await requireProject(req, params.id);
      if (await getPrisma().zone.count({ where: { projectId: p.id } })) throw new AppError('conflict', 'Delete or move the project zones first.');
      await getPrisma().project.delete({ where: { id: p.id } });
      await audit(actorOf(req), 'PROJECT_DELETE', { type: 'project', id: p.id }, { name: p.name });
    },
  }),

  // ─── Zones ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/zones',
    tag: 'Zones',
    summary: 'List zones',
    auth: 'any',
    permission: 'zones.view',
    scope: 'zones:read',
    query: z.object({ project_id: z.string().optional() }),
    responses: { 200: { description: 'Zones', example: { data: [ZONE_EXAMPLE] } } },
    async handler({ req, query }) {
      const scope = projectScope(req);
      const where: Prisma.ZoneWhereInput = {};
      if (scope) where.projectId = scope;
      else if (query.project_id) where.projectId = query.project_id;
      const rows = await getPrisma().zone.findMany({ where, include: ZONE_INCLUDE, orderBy: { name: 'asc' } });
      return { data: rows.map(serializeZone) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/zones',
    tag: 'Zones',
    summary: 'Create a zone',
    description:
      'Creates a CDN zone bound to a folder subtree. Pass `root_folder_id` to use an existing folder, or omit it to create a new top-level folder named after the zone. Every file in that subtree is delivered with the zone configuration.',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    body: z.object({ project_id: z.string(), name: z.string().trim().min(1).max(80), root_folder_id: z.string().optional(), ...zoneConfig }),
    responses: { 201: { description: 'Created zone', example: ZONE_EXAMPLE } },
    errors: ['project_not_found', 'folder_not_found', 'conflict', 'storage_provider_not_found'],
    async handler({ req, reply, body }) {
      const prisma = getPrisma();
      const project = await requireProject(req, body.project_id);
      await validateProviders([body.storage_provider_id, ...(body.replica_provider_ids ?? [])]);
      let folderId: string;
      if (body.root_folder_id) {
        const folder = await requireFolder(req, body.root_folder_id);
        if (await prisma.zone.findUnique({ where: { rootFolderId: folder.id } })) throw new AppError('conflict', 'That folder is already the root of another zone.');
        folderId = folder.id;
      } else {
        const slug = slugifySegment(body.name);
        const existing = await prisma.folder.findFirst({ where: { parentId: null, slug } });
        if (existing) throw new AppError('conflict', `A top-level folder "/${slug}" already exists; pass it as root_folder_id.`);
        const folder = await prisma.folder.create({ data: { id: newId('folder'), name: body.name, slug, parentId: null, path: `/${slug}`, createdById: req.auth?.type === 'session' ? req.auth.user.id : null } });
        folderId = folder.id;
      }
      const { project_id: _p, name, root_folder_id: _r, ...config } = body;
      const zone = await prisma.zone.create({
        data: { id: newId('zone'), projectId: project.id, name, slug: await uniqueSlug(name, 'zone'), rootFolderId: folderId, ...(zoneData(config) as object) },
        include: ZONE_INCLUDE,
      });
      invalidateZones();
      await audit(actorOf(req), 'ZONE_CREATE', { type: 'zone', id: zone.id }, { name, project_id: project.id, root_folder_id: folderId });
      reply.code(201);
      return serializeZone(zone);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/zones/:id',
    tag: 'Zones',
    summary: 'Get a zone',
    auth: 'any',
    permission: 'zones.view',
    scope: 'zones:read',
    params: idParam('zone'),
    responses: { 200: { description: 'Zone', example: ZONE_EXAMPLE } },
    errors: ['zone_not_found'],
    async handler({ req, params }) {
      return serializeZone(await requireZone(req, params.id));
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/zones/:id',
    tag: 'Zones',
    summary: 'Update a zone',
    description: 'Changes delivery configuration: TTLs, upload rules, image/video processing, hotlink and geo protection, replication strategy and replica providers.',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('zone'),
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), project_id: z.string().optional(), root_folder_id: z.string().optional(), ...zoneConfig }).strict(),
    errors: ['zone_not_found', 'storage_provider_not_found', 'conflict'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const zone = await requireZone(req, params.id);
      await validateProviders([body.storage_provider_id, ...(body.replica_provider_ids ?? [])]);
      const { name, project_id, root_folder_id, ...config } = body;
      const data = zoneData(config) as Prisma.ZoneUncheckedUpdateInput;
      if (name) data.name = name;
      if (project_id) data.projectId = (await requireProject(req, project_id)).id;
      if (root_folder_id) {
        const folder = await requireFolder(req, root_folder_id);
        const other = await prisma.zone.findUnique({ where: { rootFolderId: folder.id } });
        if (other && other.id !== zone.id) throw new AppError('conflict', 'That folder is already the root of another zone.');
        data.rootFolderId = folder.id;
      }
      const updated = await prisma.zone.update({ where: { id: zone.id }, data, include: ZONE_INCLUDE });
      invalidateZones();
      await audit(actorOf(req), 'ZONE_UPDATE', { type: 'zone', id: zone.id }, { changes: body });
      if (body.replica_provider_ids && body.replica_provider_ids.some((id) => !zone.replicaProviderIds.includes(id))) {
        void triggerZoneReplication(updated, `zone-update:${zone.id}`);
      }
      return serializeZone(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/zones/:id',
    tag: 'Zones',
    summary: 'Delete a zone',
    description: 'Deletes the zone configuration, its domains and rules. Files and the root folder are kept.',
    auth: 'session',
    permission: 'zones.manage',
    requireReauth: true,
    params: idParam('zone'),
    errors: ['zone_not_found', 'reauthentication_required'],
    async handler({ req, params }) {
      const zone = await requireZone(req, params.id);
      await getPrisma().zone.delete({ where: { id: zone.id } });
      invalidateZones();
      await audit(actorOf(req), 'ZONE_DELETE', { type: 'zone', id: zone.id }, { name: zone.name, domains: zone.domains.map((d) => d.hostname) });
    },
  }),
  defineRoute({
    method: 'PUT',
    url: '/api/v1/zones/:id/cloudflare',
    tag: 'Zones',
    summary: 'Configure Cloudflare for a zone',
    description: 'Stores the Cloudflare zone id and an API token (encrypted, never returned) used for edge purges and cache analytics. Pass `api_token: null` to remove it. The token is verified before it is saved.',
    auth: 'session',
    permission: 'zones.manage',
    requireReauth: true,
    params: idParam('zone'),
    body: z.object({ cloudflare_zone_id: z.string().regex(/^[a-f0-9]{32}$/).nullable(), api_token: z.string().min(20).max(200).nullable().optional() }),
    errors: ['zone_not_found', 'validation_failed'],
    async handler({ req, params, body }) {
      const zone = await requireZone(req, params.id);
      let tokenEnc = zone.cloudflareTokenEnc;
      if (body.api_token === null || body.cloudflare_zone_id === null) tokenEnc = null;
      else if (body.api_token) {
        try {
          await verifyCloudflareToken({ zoneId: body.cloudflare_zone_id, token: body.api_token });
        } catch (err) {
          throw new AppError('validation_failed', (err as Error).message);
        }
        tokenEnc = encryptField(getKeyring(), body.api_token, cloudflareTokenAad(zone.id));
      }
      const updated = await getPrisma().zone.update({ where: { id: zone.id }, data: { cloudflareZoneId: body.cloudflare_zone_id, cloudflareTokenEnc: tokenEnc }, include: ZONE_INCLUDE });
      invalidateZones();
      await audit(actorOf(req), 'ZONE_UPDATE', { type: 'zone', id: zone.id }, { cloudflare_zone_id: body.cloudflare_zone_id, token_changed: body.api_token !== undefined });
      return serializeZone(updated);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/zones/:id/cloudflare/test',
    tag: 'Zones',
    summary: 'Test Cloudflare credentials',
    auth: 'session',
    permission: 'zones.view',
    params: idParam('zone'),
    errors: ['zone_not_found'],
    async handler({ req, params }) {
      const cfg = cloudflareConfigFor(await requireZone(req, params.id));
      if (!cfg) return { ok: false, error: 'No Cloudflare credentials configured for this zone or globally.' };
      try {
        return { ok: true, zone: await verifyCloudflareToken(cfg) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/zones/:id/replicate',
    tag: 'Zones',
    summary: 'Run replication now',
    description: 'Creates missing replicas for every file in the zone and re-queues missing or stale ones.',
    auth: 'session',
    permission: 'zones.manage',
    params: idParam('zone'),
    errors: ['zone_not_found'],
    async handler({ req, params }) {
      const zone = await requireZone(req, params.id);
      const queued = await triggerZoneReplication(zone, `manual:${req.auth?.type === 'session' ? req.auth.user.email : 'api'}`);
      return { queued };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/zones/:id/replication',
    tag: 'Zones',
    summary: 'Replication status',
    auth: 'any',
    permission: 'zones.view',
    scope: 'zones:read',
    params: idParam('zone'),
    errors: ['zone_not_found'],
    async handler({ req, params }) {
      const zone = await requireZone(req, params.id);
      const root = zone.rootFolder?.path;
      if (!root) return { providers: [] };
      const rows = await getPrisma().$queryRaw<{ provider: string; status: string; count: bigint; bytes: bigint | null }[]>`
        SELECT r."storageProviderId" AS provider, r."status"::text AS status, count(*) AS count, sum(f."size") AS bytes
        FROM "FileReplica" r JOIN "File" f ON f."id" = r."fileId" JOIN "Folder" fo ON fo."id" = f."folderId"
        WHERE fo."path" = ${root} OR fo."path" LIKE ${`${root.replace(/[\\%_]/g, '\\$&')}/%`}
        GROUP BY 1, 2`;
      const providers = await getPrisma().storageProvider.findMany({ where: { id: { in: [...zone.replicaProviderIds, ...(zone.storageProviderId ? [zone.storageProviderId] : [])] } } });
      return {
        strategy: zone.replicationStrategy,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          region: p.region,
          health: p.healthStatus,
          latency_ms: p.latencyMs,
          role: zone.replicaProviderIds.includes(p.id) ? 'replica' : 'primary',
          replicas: Object.fromEntries(rows.filter((r) => r.provider === p.id).map((r) => [r.status, { count: Number(r.count), bytes: Number(r.bytes ?? 0) }])),
        })),
      };
    },
  }),

  // ─── Domains ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/zones/:id/domains',
    tag: 'Zones',
    summary: 'Add a custom domain',
    description:
      'Adds a hostname to the zone. The response contains the DNS records to create: a TXT record proving ownership and a CNAME (or Cloudflare Tunnel public hostname) routing traffic here. Then call `POST /api/v1/domains/{id}/verify` (verification is also retried automatically).',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('zone'),
    body: z.object({ hostname: z.string().min(3).max(253) }),
    responses: { 201: { description: 'Domain (pending verification)' } },
    errors: ['zone_not_found', 'conflict', 'validation_failed'],
    async handler({ req, reply, params, body }) {
      const zone = await requireZone(req, params.id);
      const hostname = validateHostname(body.hostname);
      const prisma = getPrisma();
      if (await prisma.zoneDomain.findUnique({ where: { hostname } })) throw new AppError('conflict', 'This hostname is already attached to a zone.');
      const domain = await prisma.zoneDomain.create({
        data: { id: newId('domain'), zoneId: zone.id, hostname, verificationToken: `cdnpanel-verify=${randomToken(24)}`, isPrimary: zone.domains.length === 0 },
      });
      await audit(actorOf(req), 'DOMAIN_ADD', { type: 'domain', id: domain.id }, { hostname, zone_id: zone.id });
      reply.code(201);
      return serializeDomain(domain);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/domains/:id/verify',
    tag: 'Zones',
    summary: 'Verify a domain',
    description: 'Checks the TXT ownership record and, once verified, probes HTTPS reachability through the edge (TLS + routing).',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('domain'),
    rateLimit: { name: 'domain-verify', max: 30, windowSeconds: 60 },
    errors: ['domain_not_found'],
    async handler({ req, params }) {
      const d = await requireDomain(req, params.id);
      const result = await verifyDomain(d, actorOf(req).actorLabel ?? 'api');
      return { domain: serializeDomain(result.domain), dns: result.dns };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/domains/:id/check',
    tag: 'Zones',
    summary: 'Run a domain health check',
    auth: 'any',
    permission: 'zones.view',
    scope: 'zones:read',
    params: idParam('domain'),
    rateLimit: { name: 'domain-check', max: 30, windowSeconds: 60 },
    errors: ['domain_not_found'],
    async handler({ req, params }) {
      const d = await requireDomain(req, params.id);
      const [dnsResult, probe] = await Promise.all([inspectDns(d), probeDomain(d)]);
      const updated = await getPrisma().zoneDomain.update({
        where: { id: d.id },
        data: { lastCheckedAt: new Date(), ...(d.status === 'ACTIVE' ? { healthStatus: probe.ok ? 'healthy' : 'unhealthy', tlsStatus: probe.tls, lastError: probe.error } : {}) },
      });
      return { domain: serializeDomain(updated), dns: dnsResult, https: probe };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/domains/:id',
    tag: 'Zones',
    summary: 'Make a domain primary',
    description: 'The primary domain is used when generating zone URLs.',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('domain'),
    body: z.object({ is_primary: z.literal(true) }),
    errors: ['domain_not_found'],
    async handler({ req, params }) {
      const d = await requireDomain(req, params.id);
      await getPrisma().$transaction([
        getPrisma().zoneDomain.updateMany({ where: { zoneId: d.zoneId }, data: { isPrimary: false } }),
        getPrisma().zoneDomain.update({ where: { id: d.id }, data: { isPrimary: true } }),
      ]);
      invalidateZones();
      return serializeDomain(await getPrisma().zoneDomain.findUniqueOrThrow({ where: { id: d.id } }));
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/domains/:id',
    tag: 'Zones',
    summary: 'Remove a domain',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('domain'),
    errors: ['domain_not_found'],
    async handler({ req, params }) {
      const d = await requireDomain(req, params.id);
      await getPrisma().zoneDomain.delete({ where: { id: d.id } });
      invalidateZones();
      await audit(actorOf(req), 'DOMAIN_REMOVE', { type: 'domain', id: d.id }, { hostname: d.hostname, zone_id: d.zoneId });
    },
  }),

  // ─── Cache rules ───
  defineRoute({
    method: 'POST',
    url: '/api/v1/zones/:id/cache-rules',
    tag: 'Cache',
    summary: 'Create a cache rule',
    description:
      'Cache rules override zone TTLs for matching paths (zone-relative globs: `*` within a segment, `**` across segments; a pattern without "/" matches the file name, e.g. `*.css`). The first matching rule by priority wins. `bypass` disables edge caching.',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('zone'),
    body: z.object({
      name: z.string().trim().min(1).max(80),
      pattern: z.string().trim().min(1).max(300),
      edge_ttl: z.number().int().min(0).max(31_536_000).nullable().optional(),
      browser_ttl: z.number().int().min(0).max(31_536_000).nullable().optional(),
      bypass: z.boolean().default(false),
      priority: z.number().int().min(0).max(10_000).default(100),
      enabled: z.boolean().default(true),
    }),
    responses: { 201: { description: 'Created rule' } },
    errors: ['zone_not_found'],
    async handler({ req, reply, params, body }) {
      const zone = await requireZone(req, params.id);
      const rule = await getPrisma().cacheRule.create({
        data: { id: newId('cacheRule'), zoneId: zone.id, name: body.name, pattern: body.pattern, edgeTtl: body.edge_ttl ?? null, browserTtl: body.browser_ttl ?? null, bypass: body.bypass, priority: body.priority, enabled: body.enabled },
      });
      invalidateZones();
      await audit(actorOf(req), 'CACHE_RULE_CREATE', { type: 'cache_rule', id: rule.id }, { zone_id: zone.id, pattern: body.pattern });
      reply.code(201);
      return serializeCacheRule(rule);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/cache-rules/:id',
    tag: 'Cache',
    summary: 'Update a cache rule',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('cacheRule'),
    body: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        pattern: z.string().trim().min(1).max(300).optional(),
        edge_ttl: z.number().int().min(0).max(31_536_000).nullable().optional(),
        browser_ttl: z.number().int().min(0).max(31_536_000).nullable().optional(),
        bypass: z.boolean().optional(),
        priority: z.number().int().min(0).max(10_000).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    errors: ['rule_not_found'],
    async handler({ req, params, body }) {
      const rule = await getPrisma().cacheRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      await requireZone(req, rule.zoneId);
      const updated = await getPrisma().cacheRule.update({
        where: { id: rule.id },
        data: { name: body.name, pattern: body.pattern, edgeTtl: body.edge_ttl, browserTtl: body.browser_ttl, bypass: body.bypass, priority: body.priority, enabled: body.enabled },
      });
      invalidateZones();
      await audit(actorOf(req), 'CACHE_RULE_UPDATE', { type: 'cache_rule', id: rule.id }, { changes: body });
      return serializeCacheRule(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/cache-rules/:id',
    tag: 'Cache',
    summary: 'Delete a cache rule',
    auth: 'any',
    permission: 'zones.manage',
    scope: 'zones:write',
    params: idParam('cacheRule'),
    errors: ['rule_not_found'],
    async handler({ req, params }) {
      const rule = await getPrisma().cacheRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      await requireZone(req, rule.zoneId);
      await getPrisma().cacheRule.delete({ where: { id: rule.id } });
      invalidateZones();
      await audit(actorOf(req), 'CACHE_RULE_DELETE', { type: 'cache_rule', id: rule.id }, { pattern: rule.pattern });
    },
  }),
];
