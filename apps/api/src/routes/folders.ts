import { z } from 'zod';
import { getPrisma, Prisma, type Folder } from '@cdn/database';
import { AppError, isValidId, newId, normalizeName, slugifySegment } from '@cdn/shared';
import { defineRoute, enforceReauth, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { audit } from '../lib/audit.js';
import { getFolderChain, hiddenFolderIds, projectFolderFilter, requireFolder } from '../lib/folders.js';
import { invalidateZones } from '../lib/zones.js';
import { serializeFolder } from '../lib/serialize.js';
import { deleteFiles } from '../services/files.js';
import { emitWebhookEvent } from '../lib/webhooks.js';

const folderParams = z.object({ id: z.string().max(64) });
const visibility = z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']);

const FOLDER_EXAMPLE = {
  id: 'fld_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'folder',
  name: 'Images',
  slug: 'images',
  parent_id: null,
  path: '/images',
  visibility: 'PUBLIC',
  restricted_to_role_ids: [],
  file_count: 12,
  folder_count: 2,
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
};

function cleanFolderName(name: string): { name: string; slug: string } {
  try {
    const clean = normalizeName(name, 'folder');
    return { name: clean, slug: slugifySegment(clean) };
  } catch {
    throw new AppError('validation_failed', 'Invalid folder name.');
  }
}

async function assertNoSiblingConflict(parentId: string | null, slug: string, excludeId?: string) {
  const conflict = await getPrisma().folder.findFirst({ where: { parentId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (conflict) throw new AppError('name_conflict', 'A folder with that name already exists here.');
}

async function validateRoleIds(ids: string[] | undefined): Promise<string[] | undefined> {
  if (!ids) return undefined;
  const unique = [...new Set(ids)];
  const found = await getPrisma().role.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw new AppError('validation_failed', 'One or more role ids do not exist.');
  return unique;
}

/** Rewrites the materialised path of a folder and all of its descendants. */
async function repath(tx: Prisma.TransactionClient, oldPath: string, newPath: string) {
  if (oldPath === newPath) return;
  await tx.$executeRaw`UPDATE "Folder" SET "path" = ${newPath} || substring("path" from ${oldPath.length + 1}) WHERE "path" = ${oldPath} OR "path" LIKE ${`${oldPath.replace(/[\\%_]/g, '\\$&')}/%`}`;
}

async function withBreadcrumbs(folder: Folder) {
  const chain = await getFolderChain(folder);
  const counts = await getPrisma().folder.findUniqueOrThrow({ where: { id: folder.id }, include: { _count: { select: { files: true, children: true } } } });
  return { ...serializeFolder(counts), breadcrumbs: chain.map((f) => ({ id: f.id, name: f.name, path: f.path })) };
}

export const folderRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/folders',
    tag: 'Folders',
    summary: 'List folders',
    description: 'Lists the direct children of `parent_id` ("root" by default). Pass `all=true` to get every accessible folder (flat, ordered by path).',
    auth: 'any',
    permission: 'files.view',
    scope: 'folders:read',
    query: pageQuery.extend({
      parent_id: z.string().refine((v) => v === 'root' || isValidId('folder', v), 'invalid folder id').default('root'),
      q: z.string().max(200).optional(),
      all: z.enum(['true', 'false']).default('false'),
    }),
    responses: { 200: { description: 'Folders', example: { data: [FOLDER_EXAMPLE], pagination: { page: 1, limit: 50, total: 1, total_pages: 1, has_more: false } } } },
    errors: ['folder_not_found'],
    async handler({ req, query }) {
      const prisma = getPrisma();
      const and: Prisma.FolderWhereInput[] = [];
      if (query.all !== 'true') {
        if (query.parent_id === 'root') and.push({ parentId: null });
        else and.push({ parentId: (await requireFolder(req, query.parent_id)).id });
      }
      if (query.q) and.push({ name: { contains: query.q, mode: 'insensitive' } });
      const hidden = await hiddenFolderIds(req);
      if (hidden.length) and.push({ id: { notIn: hidden } });
      const scope = await projectFolderFilter(req);
      if (scope) and.push(scope);
      const where = { AND: and };
      const limit = query.all === 'true' ? Math.max(query.limit, 500) : query.limit;
      const [total, rows] = await Promise.all([
        prisma.folder.count({ where }),
        prisma.folder.findMany({
          where,
          include: { _count: { select: { files: true, children: true } } },
          orderBy: query.all === 'true' ? { path: 'asc' } : { name: 'asc' },
          skip: (query.page - 1) * limit,
          take: limit,
        }),
      ]);
      return paginate(rows.map(serializeFolder), total, query.page, limit);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/folders',
    tag: 'Folders',
    summary: 'Create a folder',
    auth: 'any',
    permission: 'folders.create',
    scope: 'folders:write',
    body: z.object({
      name: z.string().min(1).max(255),
      parent_id: z.string().refine((v) => v === 'root' || isValidId('folder', v), 'invalid folder id').nullable().optional(),
      visibility: visibility.nullable().optional(),
      restricted_to_role_ids: z.array(z.string()).max(50).optional(),
    }),
    responses: { 201: { description: 'Created folder', example: FOLDER_EXAMPLE } },
    errors: ['name_conflict', 'folder_not_found', 'validation_failed'],
    async handler({ req, reply, body }) {
      const parent = body.parent_id && body.parent_id !== 'root' ? await requireFolder(req, body.parent_id) : null;
      const { name, slug } = cleanFolderName(body.name);
      await assertNoSiblingConflict(parent?.id ?? null, slug);
      if (body.restricted_to_role_ids?.length && !(req.auth?.type === 'session' && req.auth.permissions.has('roles.manage'))) {
        throw new AppError('forbidden', 'Restricting folders to roles requires the roles.manage permission.');
      }
      const folder = await getPrisma().folder.create({
        data: {
          id: newId('folder'),
          name,
          slug,
          parentId: parent?.id ?? null,
          path: `${parent?.path ?? ''}/${slug}`,
          visibility: body.visibility ?? null,
          restrictedToRoleIds: (await validateRoleIds(body.restricted_to_role_ids)) ?? [],
          createdById: req.auth?.type === 'session' ? req.auth.user.id : null,
        },
      });
      await audit(actorOf(req), 'FOLDER_CREATE', { type: 'folder', id: folder.id }, { name, path: folder.path });
      reply.code(201);
      return withBreadcrumbs(folder);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/folders/:id',
    tag: 'Folders',
    summary: 'Get a folder',
    description: 'Returns the folder with file/sub-folder counts and its breadcrumb chain.',
    auth: 'any',
    permission: 'files.view',
    scope: 'folders:read',
    params: folderParams,
    responses: { 200: { description: 'Folder', example: { ...FOLDER_EXAMPLE, breadcrumbs: [{ id: FOLDER_EXAMPLE.id, name: 'Images', path: '/images' }] } } },
    errors: ['folder_not_found', 'invalid_id'],
    async handler({ req, params }) {
      return withBreadcrumbs(await requireFolder(req, params.id));
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/folders/:id',
    tag: 'Folders',
    summary: 'Update / move a folder',
    description: 'Renames a folder, moves it under another parent (`parent_id`, or null for the top level), or changes its default visibility and role restrictions. Friendly paths of all descendants are updated.',
    auth: 'any',
    permission: 'folders.edit',
    scope: 'folders:write',
    params: folderParams,
    body: z
      .object({
        name: z.string().min(1).max(255).optional(),
        parent_id: z.string().refine((v) => v === 'root' || isValidId('folder', v), 'invalid folder id').nullable().optional(),
        visibility: visibility.nullable().optional(),
        restricted_to_role_ids: z.array(z.string()).max(50).optional(),
      })
      .strict(),
    responses: { 200: { description: 'Updated folder', example: FOLDER_EXAMPLE } },
    errors: ['folder_not_found', 'name_conflict', 'conflict', 'validation_failed'],
    async handler({ req, params, body }) {
      const prisma = getPrisma();
      const folder = await requireFolder(req, params.id);
      let parentId = folder.parentId;
      let parentPath = folder.path.slice(0, folder.path.lastIndexOf('/'));
      if (body.parent_id !== undefined) {
        const parent = body.parent_id && body.parent_id !== 'root' ? await requireFolder(req, body.parent_id) : null;
        if (parent && (parent.id === folder.id || parent.path.startsWith(`${folder.path}/`))) {
          throw new AppError('conflict', 'A folder cannot be moved into itself or one of its descendants.');
        }
        parentId = parent?.id ?? null;
        parentPath = parent?.path ?? '';
      }
      const { name, slug } = body.name !== undefined ? cleanFolderName(body.name) : { name: folder.name, slug: folder.slug };
      if (slug !== folder.slug || parentId !== folder.parentId) await assertNoSiblingConflict(parentId, slug, folder.id);
      if (body.restricted_to_role_ids !== undefined && !(req.auth?.type === 'session' && req.auth.permissions.has('roles.manage'))) {
        throw new AppError('forbidden', 'Changing folder role restrictions requires the roles.manage permission.');
      }
      const roleIds = await validateRoleIds(body.restricted_to_role_ids);
      const newPath = `${parentPath}/${slug}`;
      const updated = await prisma.$transaction(async (tx) => {
        await repath(tx, folder.path, newPath);
        return tx.folder.update({
          where: { id: folder.id },
          data: {
            name,
            slug,
            parentId,
            path: newPath,
            ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
            ...(roleIds !== undefined ? { restrictedToRoleIds: roleIds } : {}),
          },
        });
      });
      invalidateZones();
      await audit(actorOf(req), parentId !== folder.parentId ? 'FOLDER_MOVE' : 'FOLDER_UPDATE', { type: 'folder', id: folder.id }, { from_path: folder.path, to_path: newPath, changes: body });
      return withBreadcrumbs(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/folders/:id',
    tag: 'Folders',
    summary: 'Delete a folder',
    description:
      'Deletes an empty folder. With `recursive=true` all sub-folders and files are deleted too (requires `files.delete` / `files:delete`, and for staff a recent password re-authentication).',
    auth: 'any',
    permission: 'folders.delete',
    scope: 'folders:write',
    params: folderParams,
    query: z.object({ recursive: z.enum(['true', 'false']).default('false') }),
    responses: { 200: { description: 'Deleted', example: { deleted_folders: 3, deleted_files: 25 } } },
    errors: ['folder_not_found', 'conflict', 'reauthentication_required'],
    async handler({ req, params, query }) {
      const prisma = getPrisma();
      const folder = await requireFolder(req, params.id);
      const subtree = await prisma.folder.findMany({ where: { OR: [{ id: folder.id }, { path: { startsWith: `${folder.path}/` } }] } });
      const ids = subtree.map((f) => f.id);
      const files = await prisma.file.findMany({ where: { folderId: { in: ids } } });
      if (query.recursive !== 'true' && (subtree.length > 1 || files.length > 0)) {
        throw new AppError('conflict', 'The folder is not empty. Pass recursive=true to delete its contents.');
      }
      if (query.recursive === 'true') {
        const auth = req.auth!;
        if (auth.type === 'session') {
          if (!auth.permissions.has('files.delete')) throw new AppError('forbidden', 'Deleting folder contents requires files.delete.');
          await enforceReauth(auth as SessionAuth);
        } else if (!auth.scopes.has('files:delete')) {
          throw new AppError('insufficient_scope', 'Deleting folder contents requires the files:delete scope.');
        }
      }
      await deleteFiles(files);
      // Delete deepest folders first (parent relation is RESTRICT).
      for (const f of subtree.sort((a, b) => b.path.length - a.path.length)) {
        await prisma.folder.delete({ where: { id: f.id } });
      }
      invalidateZones();
      await audit(actorOf(req), 'FOLDER_DELETE', { type: 'folder', id: folder.id }, { path: folder.path, deleted_folders: subtree.length, deleted_files: files.length });
      for (const f of files) await emitWebhookEvent('file.deleted', { file: { id: f.id, name: f.name, folder_id: f.folderId } });
      return { deleted_folders: subtree.length, deleted_files: files.length };
    },
  }),
];
