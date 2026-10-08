import type { ApiKey, ApiKeyScope, File, Folder, StorageProvider, User } from '@cdn/database';
import { env } from '../config/env.js';

const n = (v: bigint | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export type FileWithRelations = File & {
  folder?: Pick<Folder, 'id' | 'path' | 'name'> | null;
  uploadedBy?: Pick<User, 'id' | 'name' | 'email'> | null;
  uploadedByApiKey?: Pick<ApiKey, 'id' | 'name' | 'prefix'> | null;
  storageProvider?: Pick<StorageProvider, 'id' | 'name' | 'kind'> | null;
};

export function fileUrls(file: Pick<File, 'id' | 'slug'>, folderPath?: string | null) {
  const e = env();
  return {
    url: `${e.CDN_URL}/files/${file.id}`,
    api_url: `${e.API_URL}/api/v1/files/${file.id}`,
    download_url: `${e.API_URL}/api/v1/files/${file.id}/download`,
    path_url: folderPath !== undefined ? `${e.CDN_URL}/p${folderPath ?? ''}/${encodeURIComponent(file.slug)}` : null,
  };
}

export function serializeFile(f: FileWithRelations) {
  return {
    id: f.id,
    object: 'file' as const,
    name: f.name,
    slug: f.slug,
    folder_id: f.folderId,
    folder_path: f.folder ? f.folder.path : f.folderId ? undefined : '/',
    mime_type: f.mimeType,
    extension: f.extension,
    size: n(f.size),
    sha256: f.sha256,
    visibility: f.visibility,
    status: f.status,
    status_reason: f.statusReason,
    cache_control: f.cacheControl,
    force_download: f.forceDownload,
    width: f.width,
    height: f.height,
    duration_seconds: f.durationSeconds,
    metadata: f.metadata,
    storage_provider: f.storageProvider ? { id: f.storageProvider.id, name: f.storageProvider.name, kind: f.storageProvider.kind } : { id: f.storageProviderId },
    uploaded_by: f.uploadedBy ? { id: f.uploadedBy.id, name: f.uploadedBy.name, email: f.uploadedBy.email } : null,
    uploaded_by_api_key: f.uploadedByApiKey ? { id: f.uploadedByApiKey.id, name: f.uploadedByApiKey.name, prefix: f.uploadedByApiKey.prefix } : null,
    download_count: n(f.downloadCount),
    bandwidth_bytes: n(f.bandwidthBytes),
    last_accessed_at: iso(f.lastAccessedAt),
    scanned_at: iso(f.scannedAt),
    cache_tags: f.cacheTags,
    version: f.version,
    expires_at: iso(f.expiresAt),
    deleted_at: iso(f.deletedAt),
    storage_class: f.storageClass,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
    ...fileUrls(f, f.folder ? f.folder.path : f.folderId ? undefined : ''),
  };
}

export const FILE_INCLUDE = {
  folder: { select: { id: true, path: true, name: true } },
  uploadedBy: { select: { id: true, name: true, email: true } },
  uploadedByApiKey: { select: { id: true, name: true, prefix: true } },
  storageProvider: { select: { id: true, name: true, kind: true } },
} as const;

export function serializeFolder(f: Folder & { _count?: { files: number; children: number } }) {
  return {
    id: f.id,
    object: 'folder' as const,
    name: f.name,
    slug: f.slug,
    parent_id: f.parentId,
    path: f.path,
    visibility: f.visibility,
    restricted_to_role_ids: f.restrictedToRoleIds,
    file_count: f._count?.files,
    folder_count: f._count?.children,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  };
}

export function apiKeyStatus(k: Pick<ApiKey, 'enabled' | 'revokedAt' | 'expiresAt' | 'suspendedAt'>): 'active' | 'disabled' | 'revoked' | 'expired' | 'suspended' {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) return 'expired';
  if (!k.enabled) return 'disabled';
  if (k.suspendedAt) return 'suspended';
  return 'active';
}

/** Never includes the key hash, and the raw key is never available. */
export function serializeApiKey(k: ApiKey & { scopes: ApiKeyScope[]; createdBy?: Pick<User, 'id' | 'name' | 'email'> | null }) {
  return {
    id: k.id,
    object: 'api_key' as const,
    name: k.name,
    prefix: k.prefix,
    masked_key: `${k.prefix}${'•'.repeat(14)}`,
    environment: k.environment.toLowerCase(),
    status: apiKeyStatus(k),
    enabled: k.enabled,
    scopes: k.scopes.map((s) => s.scope).sort(),
    rate_limit: k.rateLimit,
    ip_restrictions: k.ipRestrictions,
    allowed_endpoints: k.allowedEndpoints,
    expires_at: iso(k.expiresAt),
    revoked_at: iso(k.revokedAt),
    revoked_reason: k.revokedReason,
    last_used_at: iso(k.lastUsedAt),
    last_used_ip: k.lastUsedIp,
    request_count: n(k.requestCount),
    rotated_from_id: k.rotatedFromId,
    project_id: k.projectId,
    service_account_id: k.serviceAccountId,
    suspended_at: iso(k.suspendedAt),
    suspended_reason: k.suspendedReason,
    created_by: k.createdBy ? { id: k.createdBy.id, name: k.createdBy.name, email: k.createdBy.email } : null,
    created_at: k.createdAt.toISOString(),
    updated_at: k.updatedAt.toISOString(),
  };
}
