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
  /** Text the browser editor can open. */
  editable?: boolean;
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
  cache_tags: string[];
  version: number;
  expires_at: string | null;
  deleted_at: string | null;
  storage_class: string;
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
  status: 'active' | 'disabled' | 'revoked' | 'expired' | 'suspended';
  enabled: boolean;
  scopes: string[];
  project_id: string | null;
  service_account_id: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
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
  views: number;
  clicks: number;
  bandwidth: number;
  errors: number;
  cache_hits: number;
  avg_ms: number;
  uploads: number;
}

export interface ProjectDTO {
  id: string;
  name: string;
  slug: string;
  description: string;
  zone_count?: number;
  api_key_count?: number;
  created_at: string;
}

export interface DomainDTO {
  id: string;
  zone_id: string;
  hostname: string;
  status: 'PENDING' | 'ACTIVE' | 'FAILED';
  is_primary: boolean;
  tls_status: string;
  health_status: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  verification: { txt: { name: string; value: string }; cname: { name: string; target: string } };
  created_at: string;
}

export interface CacheRuleDTO {
  id: string;
  zone_id: string;
  name: string;
  pattern: string;
  edge_ttl: number | null;
  browser_ttl: number | null;
  bypass: boolean;
  priority: number;
  enabled: boolean;
}

export type ReplicationStrategy = 'PRIMARY_ONLY' | 'MIRROR' | 'NEAREST' | 'FAILOVER';

export interface ZoneDTO {
  id: string;
  project_id: string;
  project?: { id: string; name: string; slug: string };
  name: string;
  slug: string;
  enabled: boolean;
  root_folder: { id: string; path: string } | null;
  storage_provider_id: string | null;
  allowed_mime_types: string[];
  max_file_size: number | null;
  default_visibility: Visibility | null;
  edge_ttl: number;
  browser_ttl: number;
  image_optimization: boolean;
  require_signed_transforms: boolean;
  video_processing: boolean;
  allowed_referrers: string[];
  allow_empty_referrer: boolean;
  allowed_countries: string[];
  blocked_countries: string[];
  blocked_asns: number[];
  replication_strategy: ReplicationStrategy;
  replica_provider_ids: string[];
  cloudflare: { zone_id: string | null; token_configured: boolean };
  domains?: DomainDTO[];
  cache_rules?: CacheRuleDTO[];
  created_at: string;
}

export interface ShareDTO {
  id: string;
  file_id: string;
  file?: { id: string; name: string };
  url: string | null;
  token_prefix: string;
  title: string | null;
  message: string | null;
  has_password: boolean;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  one_time: boolean;
  allowed_ips: string[];
  allowed_countries: string[];
  require_email: boolean;
  state: 'active' | 'expired' | 'exhausted' | 'revoked';
  last_accessed_at: string | null;
  created_at: string;
}

export interface StorageProviderDTO {
  id: string;
  name: string;
  kind: 'LOCAL' | 'S3' | 'R2' | 'MINIO' | 'B2';
  is_default: boolean;
  enabled: boolean;
  region: string;
  serves_countries: string[];
  priority: number;
  health_status: string;
  latency_ms: number | null;
}

export interface UsageMetrics {
  storage_bytes: number;
  egress_bytes: number;
  requests: number;
  transforms: number;
  upload_bytes: number;
  cpu_ms: number;
}

export interface QuotaDTO {
  id: string;
  scope_type: 'global' | 'project' | 'zone' | 'api_key';
  scope_id: string;
  metric: keyof Omit<UsageMetrics, 'cpu_ms'>;
  limit: number;
  hard: boolean;
  thresholds: number[];
  alerted_percent: number;
  used: number | null;
  percent: number | null;
}

export interface CostLine {
  provider: { id: string; name: string; kind: string; region: string };
  storage_bytes: number;
  egress_bytes: number;
  requests: number;
  storage_cost: number;
  egress_cost: number;
  request_cost: number;
  total: number;
}
