import { z } from 'zod';
import { getPrisma, Prisma, type Role } from '@cdn/database';
import { AppError, isPermission, isValidId, newId, randomToken, sha256Hex, type Permission } from '@cdn/shared';
import { defineRoute, pageQuery, paginate, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { checkPasswordPolicy, hashPassword } from '../lib/password.js';
import { revokeUserSessions } from '../lib/sessions.js';

const userParams = z.object({ id: z.string().refine((v) => isValidId('user', v), 'invalid user id') });
const USER_INCLUDE = { roles: { include: { role: true } } } as const;
type UserWithRoles = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

export function serializeUser(u: UserWithRoles, extra: { active_sessions?: number } = {}) {
  return {
    id: u.id,
    object: 'user' as const,
    email: u.email,
    name: u.name,
    status: u.status,
    roles: u.roles.map((r) => ({ id: r.role.id, name: r.role.name })),
    two_factor_enabled: u.totpEnabled,
    require_two_factor: u.requireTwoFactor,
    last_login_at: u.lastLoginAt?.toISOString() ?? null,
    last_login_ip: u.lastLoginIp,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
    ...extra,
  };
}

const USER_EXAMPLE = {
  id: 'usr_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  object: 'user',
  email: 'dev@example.com',
  name: 'Dev Eloper',
  status: 'ACTIVE',
  roles: [{ id: 'role_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', name: 'Developer' }],
  two_factor_enabled: true,
  require_two_factor: false,
  last_login_at: '2026-01-01T09:00:00.000Z',
  last_login_ip: '203.0.113.10',
  created_at: '2026-01-01T08:00:00.000Z',
  updated_at: '2026-01-01T08:00:00.000Z',
};

type RoleWithPerms = Role & { permissions: { permissionKey: string }[] };

/**
 * Privilege-escalation guard: staff can only assign roles whose permissions they hold
 * themselves, and only Founders may grant or touch the Founder role.
 */
function assertCanAssign(actor: SessionAuth, roles: RoleWithPerms[]) {
  const isFounder = actor.roleNames.includes('Founder');
  for (const role of roles) {
    if (role.locked && !isFounder) throw new AppError('forbidden', `Only a Founder can assign the ${role.name} role.`);
    const missing = role.permissions.map((p) => p.permissionKey).filter((p) => isPermission(p) && !actor.permissions.has(p as Permission));
    if (missing.length) throw new AppError('forbidden', `You cannot assign the ${role.name} role because it grants permissions you do not have.`);
  }
}

async function assertCanManage(actor: SessionAuth, targetId: string) {
  const target = await getPrisma().user.findUnique({ where: { id: targetId }, include: { roles: { include: { role: true } } } });
  if (!target) throw new AppError('user_not_found');
  const targetIsFounder = target.roles.some((r) => r.role.locked);
  if (targetIsFounder && !actor.roleNames.includes('Founder')) throw new AppError('forbidden', 'Only a Founder can manage a Founder account.');
  return target;
}

async function assertNotLastFounder(userId: string) {
  const founderRole = await getPrisma().role.findFirst({ where: { locked: true } });
  if (!founderRole) return;
  const isFounder = await getPrisma().userRole.findUnique({ where: { userId_roleId: { userId, roleId: founderRole.id } } });
  if (!isFounder) return;
  const others = await getPrisma().userRole.count({ where: { roleId: founderRole.id, userId: { not: userId }, user: { status: 'ACTIVE' } } });
  if (others === 0) throw new AppError('conflict', 'This is the last active Founder account.');
}

async function loadRoles(ids: string[]): Promise<RoleWithPerms[]> {
  const unique = [...new Set(ids)];
  const roles = await getPrisma().role.findMany({ where: { id: { in: unique } }, include: { permissions: { select: { permissionKey: true } } } });
  if (roles.length !== unique.length) throw new AppError('validation_failed', 'One or more roles do not exist.');
  return roles;
}

async function issueToken(userId: string, type: 'INVITE' | 'PASSWORD_RESET'): Promise<{ url: string; expires_at: string }> {
  const prisma = getPrisma();
  const token = randomToken(32);
  const ttl = type === 'INVITE' ? 7 * 86_400_000 : 86_400_000;
  await prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  const expiresAt = new Date(Date.now() + ttl);
  await prisma.userToken.create({ data: { id: newId('userToken'), userId, type, tokenHash: sha256Hex(token), expiresAt } });
  return { url: `${env().APP_URL}/accept?token=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() };
}

export const userRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/users',
    tag: 'Users',
    summary: 'List staff users',
    auth: 'session',
    permission: 'users.view',
    query: pageQuery.extend({ q: z.string().max(200).optional(), status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional(), role_id: z.string().optional() }),
    responses: { 200: { description: 'Users', example: { data: [USER_EXAMPLE], pagination: { page: 1, limit: 50, total: 1, total_pages: 1, has_more: false } } } },
    async handler({ query }) {
      const where: Prisma.UserWhereInput = {
        AND: [
          query.q ? { OR: [{ email: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {},
          query.status ? { status: query.status } : {},
          query.role_id ? { roles: { some: { roleId: query.role_id } } } : {},
        ],
      };
      const prisma = getPrisma();
      const [total, rows] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({ where, include: USER_INCLUDE, orderBy: { createdAt: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      ]);
      return paginate(rows.map((u) => serializeUser(u)), total, query.page, query.limit);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/users',
    tag: 'Users',
    summary: 'Create or invite a staff user',
    description:
      'With `invite: true` (or no password) the account is created in the INVITED state and a one-time invitation link is returned **once** — share it with the user over a secure channel. Otherwise the account is created with the given password.',
    auth: 'session',
    permission: 'users.create',
    body: z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      name: z.string().trim().min(1).max(100),
      role_ids: z.array(z.string()).max(20).default([]),
      password: z.string().max(256).optional(),
      invite: z.boolean().default(false),
      require_two_factor: z.boolean().default(false),
    }),
    responses: { 201: { description: 'Created user', example: { user: { ...USER_EXAMPLE, status: 'INVITED' }, invite_url: 'https://panel.example.com/accept?token=…', invite_expires_at: '2026-01-08T00:00:00.000Z' } } },
    errors: ['conflict', 'validation_failed', 'forbidden'],
    async handler({ req, reply, body, auth }) {
      const actor = auth as SessionAuth;
      const prisma = getPrisma();
      if (await prisma.user.findUnique({ where: { email: body.email } })) throw new AppError('conflict', 'A user with this email already exists.');
      const roles = await loadRoles(body.role_ids);
      if (roles.length && !actor.permissions.has('users.edit')) throw new AppError('forbidden', 'Assigning roles requires users.edit.');
      assertCanAssign(actor, roles);
      const invite = body.invite || !body.password;
      if (!invite) {
        const policy = checkPasswordPolicy(body.password!, { email: body.email, name: body.name });
        if (!policy.ok) throw new AppError('validation_failed', policy.message);
      }
      const user = await prisma.user.create({
        data: {
          id: newId('user'),
          email: body.email,
          name: body.name,
          passwordHash: invite ? null : await hashPassword(body.password!),
          status: invite ? 'INVITED' : 'ACTIVE',
          requireTwoFactor: body.require_two_factor,
          createdById: actor.user.id,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
        include: USER_INCLUDE,
      });
      const token = invite ? await issueToken(user.id, 'INVITE') : null;
      await audit(actorOf(req), invite ? 'USER_INVITE' : 'USER_CREATE', { type: 'user', id: user.id }, { email: user.email, roles: roles.map((r) => r.name) });
      reply.code(201);
      reply.header('Cache-Control', 'no-store');
      return { user: serializeUser(user), invite_url: token?.url ?? null, invite_expires_at: token?.expires_at ?? null };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/users/:id',
    tag: 'Users',
    summary: 'Get a staff user',
    auth: 'session',
    permission: 'users.view',
    params: userParams,
    responses: { 200: { description: 'User', example: { ...USER_EXAMPLE, active_sessions: 2 } } },
    errors: ['user_not_found'],
    async handler({ params }) {
      const prisma = getPrisma();
      const u = await prisma.user.findUnique({ where: { id: params.id }, include: USER_INCLUDE });
      if (!u) throw new AppError('user_not_found');
      const active = await prisma.session.count({ where: { userId: u.id, revokedAt: null, expiresAt: { gt: new Date() } } });
      return serializeUser(u, { active_sessions: active });
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/users/:id',
    tag: 'Users',
    summary: 'Update a staff user',
    description: 'Updates name, roles and 2FA requirement. You can only assign roles whose permissions you hold.',
    auth: 'session',
    permission: 'users.edit',
    params: userParams,
    body: z.object({ name: z.string().trim().min(1).max(100).optional(), role_ids: z.array(z.string()).max(20).optional(), require_two_factor: z.boolean().optional() }).strict(),
    responses: { 200: { description: 'Updated user', example: USER_EXAMPLE } },
    errors: ['user_not_found', 'forbidden', 'conflict'],
    async handler({ req, params, body, auth }) {
      const actor = auth as SessionAuth;
      const prisma = getPrisma();
      const target = await assertCanManage(actor, params.id);
      let roles: RoleWithPerms[] | null = null;
      if (body.role_ids) {
        roles = await loadRoles(body.role_ids);
        // The actor must also be allowed to remove the target's current roles.
        const current = await loadRoles(target.roles.map((r) => r.roleId));
        assertCanAssign(actor, [...roles, ...current.filter((c) => !roles!.some((r) => r.id === c.id))]);
        const founderRole = current.find((r) => r.locked);
        if (founderRole && !roles.some((r) => r.id === founderRole.id)) await assertNotLastFounder(target.id);
        if (target.id === actor.user.id && !roles.some((r) => r.permissions.some((p) => p.permissionKey === 'users.edit'))) {
          throw new AppError('conflict', 'You cannot remove your own ability to manage users.');
        }
      }
      const updated = await prisma.$transaction(async (tx) => {
        if (roles) {
          await tx.userRole.deleteMany({ where: { userId: target.id } });
          await tx.userRole.createMany({ data: roles.map((r) => ({ userId: target.id, roleId: r.id })) });
        }
        return tx.user.update({
          where: { id: target.id },
          data: { ...(body.name ? { name: body.name } : {}), ...(body.require_two_factor !== undefined ? { requireTwoFactor: body.require_two_factor } : {}) },
          include: USER_INCLUDE,
        });
      });
      await audit(actorOf(req), 'USER_UPDATE', { type: 'user', id: target.id }, {
        name: body.name,
        roles: roles?.map((r) => r.name),
        previous_roles: target.roles.map((r) => r.role.name),
        require_two_factor: body.require_two_factor,
      });
      return serializeUser(updated);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/users/:id/disable',
    tag: 'Users',
    summary: 'Disable a staff user',
    description: 'Disables the account and revokes all of its sessions.',
    auth: 'session',
    permission: 'users.disable',
    params: userParams,
    responses: { 200: { description: 'Disabled user', example: { ...USER_EXAMPLE, status: 'DISABLED' } } },
    errors: ['user_not_found', 'conflict', 'forbidden'],
    async handler({ req, params, auth }) {
      const actor = auth as SessionAuth;
      if (params.id === actor.user.id) throw new AppError('conflict', 'You cannot disable your own account.');
      await assertCanManage(actor, params.id);
      await assertNotLastFounder(params.id);
      const u = await getPrisma().user.update({ where: { id: params.id }, data: { status: 'DISABLED' }, include: USER_INCLUDE });
      const revoked = await revokeUserSessions(u.id);
      await audit(actorOf(req), 'USER_DISABLE', { type: 'user', id: u.id }, { email: u.email, sessions_revoked: revoked });
      return serializeUser(u);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/users/:id/enable',
    tag: 'Users',
    summary: 'Re-enable a staff user',
    auth: 'session',
    permission: 'users.disable',
    params: userParams,
    responses: { 200: { description: 'Enabled user', example: USER_EXAMPLE } },
    errors: ['user_not_found', 'forbidden'],
    async handler({ req, params, auth }) {
      const target = await assertCanManage(auth as SessionAuth, params.id);
      const u = await getPrisma().user.update({ where: { id: params.id }, data: { status: target.passwordHash ? 'ACTIVE' : 'INVITED' }, include: USER_INCLUDE });
      await audit(actorOf(req), 'USER_ENABLE', { type: 'user', id: u.id }, { email: u.email });
      return serializeUser(u);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/users/:id',
    tag: 'Users',
    summary: 'Delete a staff user',
    description: 'Permanently deletes the account. Uploaded files and audit history are kept (attributed to a deleted user). Requires re-authentication.',
    auth: 'session',
    permission: 'users.disable',
    requireReauth: true,
    params: userParams,
    responses: { 204: { description: 'Deleted' } },
    errors: ['user_not_found', 'conflict', 'reauthentication_required'],
    async handler({ req, params, auth }) {
      const actor = auth as SessionAuth;
      if (params.id === actor.user.id) throw new AppError('conflict', 'You cannot delete your own account.');
      const target = await assertCanManage(actor, params.id);
      await assertNotLastFounder(params.id);
      await getPrisma().user.delete({ where: { id: target.id } });
      await audit(actorOf(req), 'USER_DELETE', { type: 'user', id: target.id }, { email: target.email, name: target.name });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/users/:id/reset-password',
    tag: 'Users',
    summary: 'Issue a password reset link',
    description: 'Returns a one-time password reset link (valid 24 hours) — shown once. For invited users a fresh invitation link is issued.',
    auth: 'session',
    permission: 'users.edit',
    requireReauth: true,
    params: userParams,
    responses: { 200: { description: 'Reset link', example: { url: 'https://panel.example.com/accept?token=…', expires_at: '2026-01-02T00:00:00.000Z' } } },
    errors: ['user_not_found', 'reauthentication_required'],
    async handler({ req, reply, params, auth }) {
      const target = await assertCanManage(auth as SessionAuth, params.id);
      const token = await issueToken(target.id, target.status === 'INVITED' ? 'INVITE' : 'PASSWORD_RESET');
      await audit(actorOf(req), 'PASSWORD_RESET_ISSUED', { type: 'user', id: target.id }, { email: target.email });
      reply.header('Cache-Control', 'no-store');
      return token;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/users/:id/reset-2fa',
    tag: 'Users',
    summary: 'Reset a user\'s 2FA',
    description: 'Removes the user\'s authenticator and recovery codes (e.g. lost device). Requires re-authentication.',
    auth: 'session',
    permission: 'users.edit',
    requireReauth: true,
    params: userParams,
    responses: { 204: { description: 'Reset' } },
    errors: ['user_not_found', 'reauthentication_required'],
    async handler({ req, params, auth }) {
      const target = await assertCanManage(auth as SessionAuth, params.id);
      const prisma = getPrisma();
      await prisma.$transaction([
        prisma.user.update({ where: { id: target.id }, data: { totpEnabled: false, totpSecretEnc: null } }),
        prisma.recoveryCode.deleteMany({ where: { userId: target.id } }),
      ]);
      await revokeUserSessions(target.id);
      await audit(actorOf(req), 'TWO_FACTOR_DISABLED', { type: 'user', id: target.id }, { by_admin: true });
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/users/:id/sessions',
    tag: 'Users',
    summary: 'Revoke all sessions of a user',
    auth: 'session',
    permission: 'users.disable',
    params: userParams,
    responses: { 200: { description: 'Revoked', example: { revoked: 2 } } },
    errors: ['user_not_found'],
    async handler({ req, params, auth }) {
      const target = await assertCanManage(auth as SessionAuth, params.id);
      const revoked = await revokeUserSessions(target.id);
      await audit(actorOf(req), 'SESSION_REVOKED', { type: 'user', id: target.id }, { revoked, all: true });
      return { revoked };
    },
  }),
];
