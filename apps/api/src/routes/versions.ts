import { z } from 'zod';
import type { MultipartFile } from '@fastify/multipart';
import { getPrisma, Prisma, type FileVersion, type LifecycleRule } from '@cdn/database';
import { AppError, isValidId, newId } from '@cdn/shared';
import { defineRoute, enforceReauth, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, apiKeyIdOf, userIdOf, type SessionAuth } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { hiddenFolderIds, projectFileFilter, requireFolder } from '../lib/folders.js';
import { enqueueFileProcessing } from '../lib/queue.js';
import { FILE_INCLUDE, serializeFile } from '../lib/serialize.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { invalidateZones, zoneForFolder } from '../lib/zones.js';
import { deleteFiles, deleteUnreferencedObjects, requireFile } from '../services/files.js';
import { purgeVariants } from '../services/images.js';
import { replaceFileContent, uniqueFileSlug } from '../services/ingest.js';
import { applyRule, matchingFiles, runLifecycle } from '../services/lifecycle.js';
import { autoPurgeFiles } from '../services/purge.js';

const fileParams = z.object({ id: z.string().max(64) });

function serializeVersion(v: FileVersion) {
  return {
    id: v.id,
    object: 'file_version' as const,
    file_id: v.fileId,
    version: v.version,
    name: v.name,
    mime_type: v.mimeType,
    size: Number(v.size),
    sha256: v.sha256,
    width: v.width,
    height: v.height,
    duration_seconds: v.durationSeconds,
    storage_provider_id: v.storageProviderId,
    uploaded_at: v.uploadedAt.toISOString(),
    archived_at: v.createdAt.toISOString(),
  };
}

function serializeRule(r: LifecycleRule) {
  return {
    id: r.id,
    object: 'lifecycle_rule' as const,
    name: r.name,
    zone_id: r.zoneId,
    folder_id: r.folderId,
    basis: r.basis,
    after_days: r.afterDays,
    action: r.action,
    target_storage_provider_id: r.targetStorageProviderId,
    mime_prefix: r.mimePrefix,
    enabled: r.enabled,
    last_run_at: r.lastRunAt?.toISOString() ?? null,
    last_run_count: r.lastRunCount,
    created_at: r.createdAt.toISOString(),
  };
}

const ruleBody = {
  name: z.string().trim().min(1).max(80),
  zone_id: z.string().nullable().optional(),
  folder_id: z.string().nullable().optional(),
  basis: z.enum(['created', 'last_accessed']).default('created'),
  after_days: z.number().int().min(1).max(36_500),
  action: z.enum(['TRASH', 'DELETE', 'ARCHIVE', 'MOVE_STORAGE']),
  target_storage_provider_id: z.string().nullable().optional(),
  mime_prefix: z.string().max(100).nullable().optional(),
  enabled: z.boolean().default(true),
};

export const versionRoutes: RouteDef<any, any, any>[] = [
  // ─── Revisions ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/files/:id/versions',
    tag: 'Versions',
    summary: 'List file revisions',
    description: 'Previous revisions of a file, newest first. The current revision is the file itself (`version` field).',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    params: fileParams,
    errors: ['file_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      const rows = await getPrisma().fileVersion.findMany({ where: { fileId: file.id }, orderBy: { version: 'desc' } });
      return { current_version: file.version, data: rows.map(serializeVersion) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/versions',
    tag: 'Versions',
    summary: 'Upload a new revision',
    description:
      'Replaces the content of a file while keeping its id, URLs and settings (`multipart/form-data`, field `file`). The previous content is kept as a revision; derived variants are regenerated and edge caches are purged.',
    auth: 'any',
    permission: ['files.edit', 'files.upload'],
    scope: ['files:update', 'files:upload'],
    params: fileParams,
    multipart: [
      { name: 'file', type: 'file', required: true, description: 'The new content.' },
      { name: 'sha256', type: 'string', description: 'Expected SHA-256 (hex).' },
      { name: 'keep_name', type: 'boolean', description: 'Keep the current file name (default true).' },
    ],
    responses: { 201: { description: 'Updated file' } },
    errors: ['file_not_found', 'file_too_large', 'unsupported_file_type', 'checksum_mismatch', 'quota_exceeded'],
    async handler({ req, reply, params }) {
      const file = await requireFile(req, params.id);
      if (!req.isMultipart()) throw new AppError('bad_request', 'Expected multipart/form-data with a "file" field.');
      const fields: Record<string, string> = {};
      let result = null;
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (typeof part.value === 'string') fields[part.fieldname] = part.value;
          continue;
        }
        const fp = part as MultipartFile;
        if (result) {
          fp.file.resume();
          throw new AppError('bad_request', 'Only one file may be uploaded.');
        }
        if (fields.sha256 && !/^[a-fA-F0-9]{64}$/.test(fields.sha256)) throw new AppError('validation_failed', 'sha256 must be 64 hex characters.');
        result = await replaceFileContent(file, {
          stream: fp.file,
          filename: fields.keep_name === 'false' ? fp.filename : file.name,
          expectedSha256: fields.sha256 ?? null,
          userId: userIdOf(req),
          apiKeyId: apiKeyIdOf(req),
          actor: actorOf(req),
        });
      }
      if (!result) throw new AppError('validation_failed', 'No file was provided.');
      const full = await getPrisma().file.findUniqueOrThrow({ where: { id: file.id }, include: FILE_INCLUDE });
      const zone = await zoneForFolder(file.folderId);
      await emitWebhookEvent('file.version_created', { file: serializeFile(full), previous_version: file.version }, { projectId: zone?.projectId });
      reply.code(201);
      return serializeFile(full);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/versions/:version/restore',
    tag: 'Versions',
    summary: 'Roll back to a revision',
    description: 'Makes an earlier revision current again. The content that was current becomes a new revision, so a rollback can itself be undone.',
    auth: 'any',
    permission: 'files.edit',
    scope: 'files:update',
    params: z.object({ id: z.string().max(64), version: z.coerce.number().int().min(1) }),
    errors: ['file_not_found', 'version_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id);
      const prisma = getPrisma();
      const v = await prisma.fileVersion.findUnique({ where: { fileId_version: { fileId: file.id, version: params.version } } });
      if (!v) throw new AppError('version_not_found');
      await prisma.$transaction(async (tx) => {
        await tx.fileVersion.create({
          data: {
            id: newId('fileVersion'),
            fileId: file.id,
            version: file.version,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            sha256: file.sha256,
            storageProviderId: file.storageProviderId,
            storageKey: file.storageKey,
            width: file.width,
            height: file.height,
            durationSeconds: file.durationSeconds,
            createdById: file.uploadedById,
            createdByApiKeyId: file.uploadedByApiKeyId,
            uploadedAt: file.updatedAt,
          },
        });
        await tx.file.update({
          where: { id: file.id },
          data: {
            name: v.name,
            slug: v.name === file.name ? file.slug : await uniqueFileSlug(file.folderId, v.name, file.id),
            mimeType: v.mimeType,
            size: v.size,
            sha256: v.sha256,
            storageProviderId: v.storageProviderId,
            storageKey: v.storageKey,
            width: v.width,
            height: v.height,
            durationSeconds: v.durationSeconds,
            version: file.version + 1,
          },
        });
      });
      await purgeVariants(file.id);
      await prisma.fileReplica.updateMany({ where: { fileId: file.id }, data: { status: 'PENDING', sha256: null } });
      await enqueueFileProcessing(file.id, { reprocess: true });
      await autoPurgeFiles([file], 'rollback');
      await audit(actorOf(req), 'FILE_VERSION_RESTORE', { type: 'file', id: file.id }, { restored_version: v.version, new_version: file.version + 1 });
      return serializeFile(await prisma.file.findUniqueOrThrow({ where: { id: file.id }, include: FILE_INCLUDE }));
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/files/:id/versions/:version',
    tag: 'Versions',
    summary: 'Delete a revision',
    auth: 'any',
    permission: 'files.delete',
    scope: 'files:delete',
    params: z.object({ id: z.string().max(64), version: z.coerce.number().int().min(1) }),
    errors: ['file_not_found', 'version_not_found'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id, { includeDeleted: true });
      const v = await getPrisma().fileVersion.findUnique({ where: { fileId_version: { fileId: file.id, version: params.version } } });
      if (!v) throw new AppError('version_not_found');
      await getPrisma().fileVersion.delete({ where: { id: v.id } });
      await deleteUnreferencedObjects([{ providerId: v.storageProviderId, key: v.storageKey }]);
      await audit(actorOf(req), 'FILE_VERSION_DELETE', { type: 'file', id: file.id }, { version: v.version });
    },
  }),

  // ─── Recycle bin ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/trash',
    tag: 'Versions',
    summary: 'List the recycle bin',
    description: 'Deleted files kept for the configured retention period (Settings → Files). Restore them with `POST /api/v1/files/{id}/restore`.',
    auth: 'any',
    permission: 'files.view',
    scope: 'files:read',
    query: pageQuery.extend({ q: z.string().max(200).optional() }),
    async handler({ req, query }) {
      const prisma = getPrisma();
      const and: Prisma.FileWhereInput[] = [{ deletedAt: { not: null } }];
      if (query.q) and.push({ name: { contains: query.q, mode: 'insensitive' } });
      const hidden = await hiddenFolderIds(req);
      if (hidden.length) and.push({ OR: [{ folderId: null }, { folderId: { notIn: hidden } }] });
      const scope = await projectFileFilter(req);
      if (scope) and.push(scope);
      const where = { AND: and };
      const [total, rows] = await Promise.all([
        prisma.file.count({ where }),
        prisma.file.findMany({ where, include: FILE_INCLUDE, orderBy: { deletedAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(rows.map((f) => ({ ...serializeFile(f), deleted_at: f.deletedAt!.toISOString() })), total, query.page, query.limit);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/files/:id/restore',
    tag: 'Versions',
    summary: 'Restore a file from the recycle bin',
    description: 'Restores the file into its original folder (or `folder_id`). If the original folder no longer exists the file is restored to the top level.',
    auth: 'any',
    permission: 'files.delete',
    scope: 'files:delete',
    params: fileParams,
    body: z.object({ folder_id: z.string().nullable().optional() }).default({}),
    errors: ['file_not_found', 'conflict'],
    async handler({ req, params, body }) {
      const file = await requireFile(req, params.id, { includeDeleted: true });
      if (!file.deletedAt) throw new AppError('conflict', 'The file is not in the recycle bin.');
      const prisma = getPrisma();
      let folderId = file.folderId;
      if (body.folder_id !== undefined) folderId = body.folder_id && body.folder_id !== 'root' ? (await requireFolder(req, body.folder_id)).id : null;
      else if (folderId && !(await prisma.folder.findUnique({ where: { id: folderId } }))) folderId = null;
      const slug = await uniqueFileSlug(folderId, file.name, file.id);
      const restored = await prisma.file.update({ where: { id: file.id }, data: { deletedAt: null, deletedById: null, folderId, slug, expiresAt: file.expiresAt && file.expiresAt < new Date() ? null : file.expiresAt }, include: FILE_INCLUDE });
      await audit(actorOf(req), 'FILE_RESTORE', { type: 'file', id: file.id }, { folder_id: folderId });
      const zone = await zoneForFolder(folderId);
      const serialized = serializeFile(restored);
      await emitWebhookEvent('file.restored', { file: serialized }, { projectId: zone?.projectId });
      return serialized;
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/trash/:id',
    tag: 'Versions',
    summary: 'Permanently delete a file from the recycle bin',
    auth: 'any',
    permission: 'files.delete',
    scope: 'files:delete',
    params: fileParams,
    errors: ['file_not_found', 'conflict'],
    async handler({ req, params }) {
      const file = await requireFile(req, params.id, { includeDeleted: true });
      if (!file.deletedAt) throw new AppError('conflict', 'The file is not in the recycle bin.');
      await deleteFiles([file]);
      await audit(actorOf(req), 'FILE_PURGE', { type: 'file', id: file.id }, { name: file.name });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/trash/empty',
    tag: 'Versions',
    summary: 'Empty the recycle bin',
    auth: 'session',
    permission: 'files.delete',
    requireReauth: true,
    errors: ['reauthentication_required'],
    async handler({ req, auth }) {
      await enforceReauth(auth as SessionAuth);
      const hidden = await hiddenFolderIds(req);
      const files = await getPrisma().file.findMany({ where: { deletedAt: { not: null }, ...(hidden.length ? { OR: [{ folderId: null }, { folderId: { notIn: hidden } }] } : {}) }, take: 5000 });
      await deleteFiles(files);
      await audit(actorOf(req), 'FILE_PURGE', { type: 'file' }, { count: files.length, emptied_trash: true });
      return { deleted: files.length };
    },
  }),

  // ─── Lifecycle rules ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/lifecycle-rules',
    tag: 'Lifecycle',
    summary: 'List lifecycle rules',
    auth: 'session',
    permission: 'zones.view',
    async handler() {
      const rows = await getPrisma().lifecycleRule.findMany({ orderBy: { createdAt: 'asc' } });
      return { data: rows.map(serializeRule) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/lifecycle-rules',
    tag: 'Lifecycle',
    summary: 'Create a lifecycle rule',
    description:
      'Rules run daily: files in scope (zone, folder subtree or everything) older than `after_days` — by creation or last access — are moved to the recycle bin (`TRASH`), deleted (`DELETE`), archived to cold storage (`ARCHIVE`) or moved to another provider (`MOVE_STORAGE`). Use `GET /api/v1/lifecycle-rules/{id}/preview` for a dry run.',
    auth: 'session',
    permission: 'zones.manage',
    body: z.object(ruleBody),
    responses: { 201: { description: 'Created rule' } },
    errors: ['validation_failed', 'zone_not_found', 'folder_not_found', 'storage_provider_not_found'],
    async handler({ req, reply, body }) {
      await validateRule(req, body);
      const rule = await getPrisma().lifecycleRule.create({
        data: {
          id: newId('lifecycleRule'),
          name: body.name,
          zoneId: body.zone_id ?? null,
          folderId: body.folder_id ?? null,
          basis: body.basis,
          afterDays: body.after_days,
          action: body.action,
          targetStorageProviderId: body.target_storage_provider_id ?? null,
          mimePrefix: body.mime_prefix ?? null,
          enabled: body.enabled,
        },
      });
      await audit(actorOf(req), 'LIFECYCLE_RULE_CREATE', { type: 'lifecycle_rule', id: rule.id }, { ...body });
      reply.code(201);
      return serializeRule(rule);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/lifecycle-rules/:id',
    tag: 'Lifecycle',
    summary: 'Update a lifecycle rule',
    auth: 'session',
    permission: 'zones.manage',
    params: z.object({ id: z.string() }),
    body: z.object({ ...ruleBody, name: ruleBody.name.optional(), after_days: ruleBody.after_days.optional(), action: ruleBody.action.optional(), basis: z.enum(['created', 'last_accessed']).optional(), enabled: z.boolean().optional() }).strict(),
    errors: ['rule_not_found'],
    async handler({ req, params, body }) {
      const rule = await getPrisma().lifecycleRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      const merged = { action: body.action ?? rule.action, target_storage_provider_id: body.target_storage_provider_id === undefined ? rule.targetStorageProviderId : body.target_storage_provider_id, zone_id: body.zone_id, folder_id: body.folder_id };
      await validateRule(req, merged);
      const updated = await getPrisma().lifecycleRule.update({
        where: { id: rule.id },
        data: {
          name: body.name,
          zoneId: body.zone_id,
          folderId: body.folder_id,
          basis: body.basis,
          afterDays: body.after_days,
          action: body.action,
          targetStorageProviderId: body.target_storage_provider_id,
          mimePrefix: body.mime_prefix,
          enabled: body.enabled,
        },
      });
      await audit(actorOf(req), 'LIFECYCLE_RULE_UPDATE', { type: 'lifecycle_rule', id: rule.id }, { changes: body });
      return serializeRule(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/lifecycle-rules/:id',
    tag: 'Lifecycle',
    summary: 'Delete a lifecycle rule',
    auth: 'session',
    permission: 'zones.manage',
    params: z.object({ id: z.string() }),
    errors: ['rule_not_found'],
    async handler({ req, params }) {
      const rule = await getPrisma().lifecycleRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      await getPrisma().lifecycleRule.delete({ where: { id: rule.id } });
      await audit(actorOf(req), 'LIFECYCLE_RULE_DELETE', { type: 'lifecycle_rule', id: rule.id }, { name: rule.name });
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/lifecycle-rules/:id/preview',
    tag: 'Lifecycle',
    summary: 'Dry-run a lifecycle rule',
    auth: 'session',
    permission: 'zones.view',
    params: z.object({ id: z.string() }),
    errors: ['rule_not_found'],
    async handler({ params }) {
      const rule = await getPrisma().lifecycleRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      const files = await matchingFiles(rule, 100);
      return { matches: files.length, capped: files.length === 100, sample: files.slice(0, 25).map((f) => ({ id: f.id, name: f.name, size: Number(f.size), created_at: f.createdAt.toISOString(), last_accessed_at: f.lastAccessedAt?.toISOString() ?? null })) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/lifecycle-rules/:id/run',
    tag: 'Lifecycle',
    summary: 'Run a lifecycle rule now',
    auth: 'session',
    permission: 'zones.manage',
    requireReauth: true,
    params: z.object({ id: z.string() }),
    errors: ['rule_not_found', 'reauthentication_required'],
    async handler({ params }) {
      const rule = await getPrisma().lifecycleRule.findUnique({ where: { id: params.id } });
      if (!rule) throw new AppError('rule_not_found');
      return { processed: await applyRule(rule) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/lifecycle/run',
    tag: 'Lifecycle',
    summary: 'Run all lifecycle processing now',
    description: 'Expires files, applies every enabled rule, purges the recycle bin and prunes old revisions.',
    auth: 'session',
    permission: 'zones.manage',
    requireReauth: true,
    errors: ['reauthentication_required'],
    async handler() {
      const result = await runLifecycle();
      invalidateZones();
      return result;
    },
  }),
];

async function validateRule(
  req: Parameters<typeof requireFolder>[0],
  body: { action?: string; target_storage_provider_id?: string | null; zone_id?: string | null; folder_id?: string | null },
): Promise<void> {
  if (body.zone_id && body.folder_id) throw new AppError('validation_failed', 'Scope a rule to a zone or a folder, not both.');
  if (body.zone_id && !(await getPrisma().zone.findUnique({ where: { id: body.zone_id } }))) throw new AppError('zone_not_found');
  if (body.folder_id) await requireFolder(req, body.folder_id);
  if (body.action === 'ARCHIVE' || body.action === 'MOVE_STORAGE') {
    if (!body.target_storage_provider_id) throw new AppError('validation_failed', `${body.action} requires target_storage_provider_id.`);
    if (!(await getPrisma().storageProvider.findUnique({ where: { id: body.target_storage_provider_id } }))) throw new AppError('storage_provider_not_found');
  }
  if (body.zone_id && !isValidId('zone', body.zone_id)) throw new AppError('invalid_id');
}
