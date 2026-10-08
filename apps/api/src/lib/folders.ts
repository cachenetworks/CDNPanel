import type { FastifyRequest } from 'fastify';
import { getPrisma, type Folder, type Prisma, type Visibility } from '@cdn/database';
import { AppError, isValidId } from '@cdn/shared';
import { securityEvent } from './audit.js';
import { pathWithin, projectRootPaths } from './zones.js';

/** All ancestor paths of a folder path, including itself: "/a/b" -> ["/a", "/a/b"]. */
export function pathPrefixes(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

export async function getFolderChain(folder: Pick<Folder, 'path'>): Promise<Folder[]> {
  const chain = await getPrisma().folder.findMany({ where: { path: { in: pathPrefixes(folder.path) } } });
  return chain.sort((a, b) => a.path.length - b.path.length);
}

/** Nearest explicit folder visibility walking up the tree. */
export async function inheritedVisibility(folderId: string | null): Promise<Visibility | null> {
  if (!folderId) return null;
  const folder = await getPrisma().folder.findUnique({ where: { id: folderId } });
  if (!folder) return null;
  const chain = await getFolderChain(folder);
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = chain[i]!.visibility;
    if (v) return v;
  }
  return null;
}

/**
 * Folder-level permissions: a folder may be restricted to specific staff roles. The
 * restriction applies to the folder and its whole subtree. Staff with `settings.edit`
 * (administrators) always have access. API keys are governed by their scopes.
 */
export function canAccessChain(req: FastifyRequest, chain: Folder[]): boolean {
  const auth = req.auth;
  if (!auth || auth.type !== 'session') return true;
  if (auth.permissions.has('settings.edit')) return true;
  return chain.every((f) => f.restrictedToRoleIds.length === 0 || f.restrictedToRoleIds.some((r) => auth.roleIds.includes(r)));
}

/**
 * Folder roots an API key is confined to (the root folders of its project's zones),
 * or null when the caller is unrestricted.
 */
export async function apiKeyRoots(req: FastifyRequest): Promise<string[] | null> {
  const auth = req.auth;
  if (!auth || auth.type !== 'api_key' || !auth.apiKey.projectId) return null;
  return projectRootPaths(auth.apiKey.projectId);
}

/** Throws (as not-found) when a project-bound API key reaches outside its project's zones. */
export async function assertWithinApiKeyProject(req: FastifyRequest, folderPath: string | null, notFound: 'folder_not_found' | 'file_not_found'): Promise<void> {
  const roots = await apiKeyRoots(req);
  if (!roots) return;
  if (folderPath && pathWithin(folderPath, roots)) return;
  const auth = req.auth;
  void securityEvent('API_KEY_PROJECT_DENIED', { ip: req.clientIp, apiKeyId: auth?.type === 'api_key' ? auth.apiKey.id : null, severity: 'info', details: { path: folderPath ?? '/' } });
  throw new AppError(notFound);
}

/** Prisma filter restricting files to the caller's project scope (null = no restriction). */
export async function projectFileFilter(req: FastifyRequest): Promise<Prisma.FileWhereInput | null> {
  const roots = await apiKeyRoots(req);
  if (!roots) return null;
  if (roots.length === 0) return { id: { in: [] } };
  return { folder: { OR: roots.flatMap((r) => [{ path: r }, { path: { startsWith: `${r}/` } }]) } };
}

/** Prisma filter restricting folders to the caller's project scope (null = no restriction). */
export async function projectFolderFilter(req: FastifyRequest): Promise<Prisma.FolderWhereInput | null> {
  const roots = await apiKeyRoots(req);
  if (!roots) return null;
  if (roots.length === 0) return { id: { in: [] } };
  return { OR: roots.flatMap((r) => [{ path: r }, { path: { startsWith: `${r}/` } }]) };
}

/**
 * Destination for uploads that do not name a folder: the library root, or for a project-bound
 * API key the root folder of the project's first zone (root uploads would escape the project).
 */
export async function defaultUploadFolder(req: FastifyRequest): Promise<string | null> {
  const auth = req.auth;
  if (!auth || auth.type !== 'api_key' || !auth.apiKey.projectId) return null;
  const roots = await projectRootPaths(auth.apiKey.projectId);
  if (roots.length === 0) throw new AppError('forbidden', 'This API key is bound to a project without zones.');
  const folder = await getPrisma().folder.findUnique({ where: { path: roots.sort()[0]! } });
  if (!folder) throw new AppError('folder_not_found');
  return folder.id;
}

/** Loads a folder and asserts it exists and the caller may access it. */
export async function requireFolder(req: FastifyRequest, folderId: string): Promise<Folder> {
  if (!isValidId('folder', folderId)) throw new AppError('invalid_id', 'The folder id is malformed.');
  const folder = await getPrisma().folder.findUnique({ where: { id: folderId } });
  if (!folder) throw new AppError('folder_not_found');
  if (!canAccessChain(req, await getFolderChain(folder))) throw new AppError('folder_not_found');
  await assertWithinApiKeyProject(req, folder.path, 'folder_not_found');
  return folder;
}

/** Ids of folders the session user cannot see (used to filter listings). */
export async function hiddenFolderIds(req: FastifyRequest): Promise<string[]> {
  const auth = req.auth;
  if (!auth || auth.type !== 'session' || auth.permissions.has('settings.edit')) return [];
  const prisma = getPrisma();
  const restricted = await prisma.folder.findMany({ where: { NOT: { restrictedToRoleIds: { isEmpty: true } } } });
  const blockedRoots = restricted.filter((f) => !f.restrictedToRoleIds.some((r) => auth.roleIds.includes(r)));
  if (blockedRoots.length === 0) return [];
  const descendants = await prisma.folder.findMany({
    where: { OR: blockedRoots.flatMap((f) => [{ id: f.id }, { path: { startsWith: `${f.path}/` } }]) },
    select: { id: true },
  });
  return descendants.map((d) => d.id);
}
