import type { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, DEFAULT_ROLES, PERMISSIONS, newId } from '@cdn/shared';

/**
 * Idempotent seed: permissions catalogue and default roles.
 * It never creates user accounts — use `npm run create-admin` for the first administrator.
 */
export async function seedDatabase(prisma: PrismaClient): Promise<{ permissions: number; roles: number }> {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, description: PERMISSIONS[key] },
      update: { description: PERMISSIONS[key] },
    });
  }
  // Remove permissions that no longer exist in code.
  await prisma.permission.deleteMany({ where: { key: { notIn: ALL_PERMISSIONS } } });

  let roles = 0;
  for (const def of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { name: def.name } });
    if (existing) {
      // Locked roles (Founder) are always kept in sync with the full permission set.
      if (def.locked) {
        await prisma.rolePermission.deleteMany({ where: { roleId: existing.id } });
        await prisma.rolePermission.createMany({
          data: def.permissions.map((permissionKey) => ({ roleId: existing.id, permissionKey })),
        });
      }
      await prisma.role.update({ where: { id: existing.id }, data: { system: def.system, locked: def.locked ?? false } });
      continue;
    }
    await prisma.role.create({
      data: {
        id: newId('role'),
        name: def.name,
        description: def.description,
        system: def.system,
        locked: def.locked ?? false,
        permissions: { create: def.permissions.map((permissionKey) => ({ permissionKey })) },
      },
    });
    roles++;
  }
  return { permissions: ALL_PERMISSIONS.length, roles };
}
