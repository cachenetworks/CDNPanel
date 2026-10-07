export type Visibility = 'PUBLIC' | 'PRIVATE' | 'AUTHENTICATED' | 'SIGNED_URL_ONLY';
export const VISIBILITIES: { value: Visibility; label: string; description: string }[] = [
  { value: 'PUBLIC', label: 'Public', description: 'Anyone with the URL' },
  { value: 'AUTHENTICATED', label: 'Authenticated', description: 'Any valid API key or staff' },
  { value: 'PRIVATE', label: 'Private', description: 'API keys with files:read, or a signed URL' },
  { value: 'SIGNED_URL_ONLY', label: 'Signed URL only', description: 'Only via an expiring signed URL' },
];

export interface FileDTO {
  id: string;
  name: string;
  slug: string;
  folder_id: string | null;
  folder_path?: string | null;
  mime_type: string;
  extension: string;
  size: number;
  sha256: string | null;
  visibility: Visibility;
  status: 'UPLOADING' | 'PROCESSING' | 'SCANNING' | 'READY' | 'QUARANTINED' | 'FAILED';
  status_reason: string | null;
  cache_control: string | null;
  force_download: boolean;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown>;
  storage_provider: { id: string; name?: string; kind?: string };
  uploaded_by: { id: string; name: string; email: string } | null;
  uploaded_by_api_key: { id: string; name: string; prefix: string } | null;
  download_count: number;
  bandwidth_bytes: number;
  last_accessed_at: string | null;
  scanned_at: string | null;
  created_at: string;
  updated_at: string;
  url: string;
  api_url: string;
  download_url: string;
  path_url: string | null;
}

export interface FolderDTO {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  path: string;
  visibility: Visibility | null;
  restricted_to_role_ids: string[];
  file_count?: number;
  folder_count?: number;
  created_at: string;
  updated_at: string;
  breadcrumbs?: { id: string; name: string; path: string }[];
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  masked_key: string;
  environment: 'live' | 'test';
  status: 'active' | 'disabled' | 'revoked' | 'expired';
  enabled: boolean;
  scopes: string[];
  rate_limit: number | null;
  ip_restrictions: string[];
  allowed_endpoints: string[];
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  created_by: { id: string; name: string; email: string } | null;
  created_at: string;
  notes?: string | null;
}

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  roles: { id: string; name: string }[];
  two_factor_enabled: boolean;
  require_two_factor: boolean;
  last_login_at: string | null;
  last_login_ip: string | null;
  created_at: string;
  active_sessions?: number;
}

export interface RoleDTO {
  id: string;
  name: string;
  description: string;
  system: boolean;
  locked: boolean;
  permissions: string[];
  user_count: number;
}

export interface SeriesPoint {
  t: string;
  requests: number;
  downloads: number;
  bandwidth: number;
  errors: number;
  cache_hits: number;
  avg_ms: number;
  uploads: number;
}
