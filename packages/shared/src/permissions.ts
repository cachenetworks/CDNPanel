/**
 * Granular RBAC permissions for staff and API-key scopes.
 * This module is free of Node-only imports so the dashboard can use it for UI gating;
 * the server is always the source of truth for enforcement.
 */

export const PERMISSIONS = {
  'files.view': 'View files and their metadata',
  'files.upload': 'Upload new files',
  'files.edit': 'Rename, move, copy and change file settings',
  'files.delete': 'Delete files',
  'files.download': 'Download private files',
  'folders.create': 'Create folders',
  'folders.edit': 'Rename and move folders, change folder settings',
  'folders.delete': 'Delete folders',
  'api_keys.view': 'View API keys',
  'api_keys.create': 'Create API keys',
  'api_keys.revoke': 'Disable and revoke API keys',
  'api_keys.rotate': 'Rotate API keys',
  'users.view': 'View staff accounts',
  'users.create': 'Create and invite staff',
  'users.edit': 'Edit staff, assign roles, reset passwords',
  'users.disable': 'Disable and delete staff, revoke their sessions',
  'roles.view': 'View roles',
  'roles.manage': 'Create, edit and delete roles',
  'analytics.view': 'View analytics',
  'logs.view': 'View audit logs and security events',
  'settings.view': 'View settings',
  'settings.edit': 'Change settings and webhooks',
  'storage.manage': 'Manage storage providers',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'Files', permissions: ['files.view', 'files.upload', 'files.edit', 'files.delete', 'files.download'] },
  { label: 'Folders', permissions: ['folders.create', 'folders.edit', 'folders.delete'] },
  { label: 'API keys', permissions: ['api_keys.view', 'api_keys.create', 'api_keys.revoke', 'api_keys.rotate'] },
  { label: 'Users', permissions: ['users.view', 'users.create', 'users.edit', 'users.disable'] },
  { label: 'Roles', permissions: ['roles.view', 'roles.manage'] },
  { label: 'Monitoring', permissions: ['analytics.view', 'logs.view'] },
  { label: 'Administration', permissions: ['settings.view', 'settings.edit', 'storage.manage'] },
];

export interface DefaultRole {
  name: string;
  description: string;
  permissions: Permission[];
  /** System roles cannot be deleted; the Founder role also cannot be edited. */
  system: boolean;
  locked?: boolean;
}

const VIEW_ONLY: Permission[] = ['files.view', 'analytics.view'];

export const DEFAULT_ROLES: DefaultRole[] = [
  {
    name: 'Founder',
    description: 'Unrestricted access to everything. Cannot be modified.',
    permissions: ALL_PERMISSIONS,
    system: true,
    locked: true,
  },
  {
    name: 'Administrator',
    description: 'Full administrative access.',
    permissions: ALL_PERMISSIONS,
    system: true,
  },
  {
    name: 'Developer',
    description: 'Manages files, folders, API keys and integrations.',
    permissions: [
      'files.view', 'files.upload', 'files.edit', 'files.delete', 'files.download',
      'folders.create', 'folders.edit', 'folders.delete',
      'api_keys.view', 'api_keys.create', 'api_keys.revoke', 'api_keys.rotate',
      'analytics.view', 'logs.view', 'settings.view',
    ],
    system: true,
  },
  {
    name: 'Moderator',
    description: 'Reviews and removes content.',
    permissions: ['files.view', 'files.edit', 'files.delete', 'files.download', 'folders.edit', 'analytics.view', 'logs.view'],
    system: true,
  },
  {
    name: 'Support',
    description: 'Assists users and inspects files and logs.',
    permissions: ['files.view', 'files.download', 'users.view', 'analytics.view', 'logs.view'],
    system: true,
  },
  {
    name: 'Uploader',
    description: 'Uploads and organises files.',
    permissions: ['files.view', 'files.upload', 'files.edit', 'files.download', 'folders.create'],
    system: true,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to files and analytics.',
    permissions: VIEW_ONLY,
    system: true,
  },
];

export const API_SCOPES = {
  'files:read': 'List, inspect and download files, create signed URLs',
  'files:upload': 'Upload files',
  'files:update': 'Rename, move, copy files and change file settings',
  'files:delete': 'Delete files',
  'folders:read': 'List and inspect folders',
  'folders:write': 'Create, update and delete folders',
  'analytics:read': 'Read analytics',
  'metadata:read': 'Read file metadata',
  'metadata:write': 'Write custom file metadata',
} as const;

export type ApiScope = keyof typeof API_SCOPES;
export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[];

export function isApiScope(value: string): value is ApiScope {
  return Object.prototype.hasOwnProperty.call(API_SCOPES, value);
}

export function hasAllPermissions(granted: Iterable<string>, required: readonly Permission[]): boolean {
  const set = granted instanceof Set ? (granted as Set<string>) : new Set(granted);
  return required.every((p) => set.has(p));
}

/**
 * Matches an endpoint restriction pattern against a method + route.
 * Patterns look like `GET /api/v1/files*` or `* /api/v1/folders/*`.
 * `*` in the path matches any sequence of characters; method `*` matches any method.
 */
export function endpointMatches(pattern: string, method: string, path: string): boolean {
  const trimmed = pattern.trim();
  const space = trimmed.indexOf(' ');
  const pMethod = space === -1 ? '*' : trimmed.slice(0, space).toUpperCase();
  const pPath = space === -1 ? trimmed : trimmed.slice(space + 1).trim();
  if (pMethod !== '*' && pMethod !== method.toUpperCase()) return false;
  const escaped = pPath.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(path);
}
