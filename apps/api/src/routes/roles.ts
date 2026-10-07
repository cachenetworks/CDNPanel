import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { ALL_PERMISSIONS, AppError, PERMISSION_GROUPS, PERMISSIONS, isPermission, isValidId, newId, type Permission } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { audit } from '../lib/audit.js';

const roleParams = z.object({ id: z.string().refine((v) => isValidId('role', v), 'invalid role id') });
const permList = z.array(z.string()).max(ALL_PERMISSIONS.length).refine((a) => a.every(isPermission), 'unknown permission');

const ROLE_EXAMPLE = {
  id: 'role_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'role',
  name: 'Release Manager',
  description: 'Publishes release artifacts',
  system: false,
  locked: false,
  permissions: ['files.view', 'files.upload', 'folders.create'],
  user_count: 3,
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
};

function assertNoEscalation(actor: SessionAuth, perms: string[]) {
  const missing = perms.filter((p) => !actor.permissions.has(p as Permission));
  if (missing.length) throw new AppError('forbidden', `You cannot grant permissions you do not have: ${missing.join(', ')}`);
}

export const roleRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/permissions',
    tag: 'Roles',
    summary: 'List permissions',
    description: 'The catalogue of granular staff permissions, grouped for display.',
    auth: 'session',
    permission: 'roles.view',
    responses: { 200: { description: 'Permissions', example: { data: [{ key: 'files.view', description: 'View files and their metadata' }], groups: [{ label: 'Files', permissions: ['files.view'] }] } } },
    async handler() {
      return { data: ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSIONS[key] })), groups: PERMISSION_GROUPS };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/roles',
    tag: 'Roles',
    summary: 'List roles',
    auth: 'session',
    permission: 'roles.view',
    responses: { 200: { description: 'Roles', example: { data: [ROLE_EXAMPLE] } } },
    async handler() {
      const roles = await getPrisma().role.findMany({ include: { permissions: true, _count: { select: { users: true } } }, orderBy: [{ system: 'desc' }, { createdAt: 'asc' }] });
      return {
        data: roles.map((r) => ({
          id: r.id,
          object: 'role',
          name: r.name,
          description: r.description,
          system: r.system,
          locked: r.locked,
          permissions: r.permissions.map((p) => p.permissionKey).sort(),
          user_count: r._count.users,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        })),
      };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/roles',
    tag: 'Roles',
    summary: 'Create a custom role',
    description: 'You can only include permissions that you hold yourself.',
    auth: 'session',
    permission: 'roles.manage',
    body: z.object({ name: z.string().trim().min(2).max(50), description: z.string().max(300).default(''), permissions: permList }),
    responses: { 201: { description: 'Created role', example: ROLE_EXAMPLE } },
    errors: ['conflict', 'forbidden'],
    async handler({ req, reply, body, auth }) {
      assertNoEscalation(auth as SessionAuth, body.permissions);
      const prisma = getPrisma();
      if (await prisma.role.findFirst({ where: { name: { equals: body.name, mode: 'insensitive' } } })) throw new AppError('conflict', 'A role with this name already exists.');
      const role = await prisma.role.create({
        data: { id: newId('role'), name: body.name, description: body.description, permissions: { create: [...new Set(body.permissions as string[])].map((permissionKey) => ({ permissionKey })) } },
        include: { permissions: true },
      });
      await audit(actorOf(req), 'ROLE_CREATED', { type: 'role', id: role.id }, { name: role.name, permissions: body.permissions });
      reply.code(201);
      return { ...ROLE_EXAMPLE, id: role.id, name: role.name, description: role.description, system: false, locked: false, permissions: role.permissions.map((p) => p.permissionKey).sort(), user_count: 0, created_at: role.createdAt.toISOString(), updated_at: role.updatedAt.toISOString() };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/roles/:id',
    tag: 'Roles',
    summary: 'Update a role',
    description: 'Changes a role\'s name, description or permissions. Locked roles (Founder) cannot be modified; system role names cannot be changed.',
    auth: 'session',
    permission: 'roles.manage',
    params: roleParams,
    body: z.object({ name: z.string().trim().min(2).max(50).optional(), description: z.string().max(300).optional(), permissions: permList.optional() }).strict(),
    responses: { 200: { description: 'Updated role', example: ROLE_EXAMPLE } },
    errors: ['role_not_found', 'forbidden', 'conflict'],
    async handler({ req, params, body, auth }) {
      const actor = auth as SessionAuth;
      const prisma = getPrisma();
      const role = await prisma.role.findUnique({ where: { id: params.id }, include: { permissions: true } });
      if (!role) throw new AppError('role_not_found');
      if (role.locked) throw new AppError('forbidden', 'This role cannot be modified.');
      if (role.system && body.name && body.name !== role.name) throw new AppError('forbidden', 'System roles cannot be renamed.');
      if (body.permissions) {
        // Both added and removed permissions must be held by the actor.
        const before = role.permissions.map((p) => p.permissionKey);
        const changed = [...body.permissions.filter((p: string) => !before.includes(p)), ...before.filter((p) => !(body.permissions as string[]).includes(p))];
        assertNoEscalation(actor, changed);
        if (actor.roleIds.includes(role.id) && !(body.permissions as string[]).includes('roles.manage') && !actor.roleNames.includes('Founder')) {
          throw new AppError('conflict', 'You cannot remove roles.manage from a role you hold.');
        }
      }
      if (body.name && body.name !== role.name && (await prisma.role.findFirst({ where: { name: { equals: body.name, mode: 'insensitive' }, id: { not: role.id } } }))) {
        throw new AppError('conflict', 'A role with this name already exists.');
      }
      const updated = await prisma.$transaction(async (tx) => {
        if (body.permissions) {
          await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
          await tx.rolePermission.createMany({ data: [...new Set(body.permissions as string[])].map((permissionKey) => ({ roleId: role.id, permissionKey })) });
        }
        return tx.role.update({
          where: { id: role.id },
          data: { ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}) },
          include: { permissions: true, _count: { select: { users: true } } },
        });
      });
      await audit(actorOf(req), 'ROLE_UPDATED', { type: 'role', id: role.id }, {
        name: updated.name,
        previous_permissions: role.permissions.map((p) => p.permissionKey),
        permissions: body.permissions,
      });
      return {
        id: updated.id,
        object: 'role',
        name: updated.name,
        description: updated.description,
        system: updated.system,
        locked: updated.locked,
        permissions: updated.permissions.map((p) => p.permissionKey).sort(),
        user_count: updated._count.users,
        created_at: updated.createdAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
      };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/roles/:id',
    tag: 'Roles',
    summary: 'Delete a custom role',
    description: 'System roles cannot be deleted. Users holding the role lose it. Requires re-authentication.',
    auth: 'session',
    permission: 'roles.manage',
    requireReauth: true,
    params: roleParams,
    responses: { 204: { description: 'Deleted' } },
    errors: ['role_not_found', 'forbidden', 'reauthentication_required'],
    async handler({ req, params }) {
      const prisma = getPrisma();
      const role = await prisma.role.findUnique({ where: { id: params.id } });
      if (!role) throw new AppError('role_not_found');
      if (role.system) throw new AppError('forbidden', 'System roles cannot be deleted.');
      await prisma.role.delete({ where: { id: role.id } });
      await prisma.$executeRaw`UPDATE "Folder" SET "restrictedToRoleIds" = array_remove("restrictedToRoleIds", ${role.id})`;
      await audit(actorOf(req), 'ROLE_DELETED', { type: 'role', id: role.id }, { name: role.name });
    },
  }),
];
