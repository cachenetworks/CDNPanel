import { decryptField } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import type { Zone } from '@cdn/database';

/**
 * Minimal Cloudflare API client for edge cache purges and cache analytics.
 * Credentials come from the zone (encrypted token) or the global CLOUDFLARE_* environment.
 * The token needs "Zone → Cache Purge: Purge" and (for analytics) "Zone → Analytics: Read".
 */

export interface CloudflareConfig {
  zoneId: string;
  token: string;
}

const API = 'https://api.cloudflare.com/client/v4';

export function cloudflareTokenAad(zoneId: string): string {
  return `zone_cloudflare_token:${zoneId}`;
}

export function cloudflareConfigFor(zone: Pick<Zone, 'id' | 'cloudflareZoneId' | 'cloudflareTokenEnc'> | null): CloudflareConfig | null {
  if (zone?.cloudflareZoneId && zone.cloudflareTokenEnc) {
    return { zoneId: zone.cloudflareZoneId, token: decryptField(getKeyring(), zone.cloudflareTokenEnc, cloudflareTokenAad(zone.id)) };
  }
  const e = env();
  if (e.CLOUDFLARE_API_TOKEN && (zone?.cloudflareZoneId || e.CLOUDFLARE_ZONE_ID)) {
    return { zoneId: (zone?.cloudflareZoneId || e.CLOUDFLARE_ZONE_ID)!, token: e.CLOUDFLARE_API_TOKEN };
  }
  return null;
}

async function cf<T>(cfg: CloudflareConfig, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[]; result?: T; data?: T };
  if (!res.ok || data.success === false) {
    const msg = data.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return (data.result ?? data.data ?? data) as T;
}

export interface PurgeRequest {
  files?: string[];
  tags?: string[];
  prefixes?: string[];
  hosts?: string[];
  everything?: boolean;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Purges the Cloudflare cache. Large lists are split into API-sized batches. */
export async function purgeCloudflare(cfg: CloudflareConfig, req: PurgeRequest): Promise<{ requests: number }> {
  const path = `/zones/${encodeURIComponent(cfg.zoneId)}/purge_cache`;
  if (req.everything) {
    await cf(cfg, path, { method: 'POST', body: { purge_everything: true } });
    return { requests: 1 };
  }
  let requests = 0;
  for (const files of chunk(req.files ?? [], 30)) {
    await cf(cfg, path, { method: 'POST', body: { files } });
    requests++;
  }
  for (const tags of chunk(req.tags ?? [], 30)) {
    await cf(cfg, path, { method: 'POST', body: { tags } });
    requests++;
  }
  for (const prefixes of chunk((req.prefixes ?? []).map((p) => p.replace(/^https?:\/\//, '')), 30)) {
    await cf(cfg, path, { method: 'POST', body: { prefixes } });
    requests++;
  }
  for (const hosts of chunk(req.hosts ?? [], 30)) {
    await cf(cfg, path, { method: 'POST', body: { hosts } });
    requests++;
  }
  return { requests };
}

export interface EdgeCacheStats {
  source: 'cloudflare';
  since: string;
  until: string;
  statuses: { status: string; requests: number; bytes: number }[];
  hit_ratio: number;
}

/** Edge cache status breakdown (HIT / MISS / EXPIRED / BYPASS / DYNAMIC / REVALIDATED …). */
export async function cloudflareCacheStats(cfg: CloudflareConfig, since: Date, until: Date, hosts?: string[]): Promise<EdgeCacheStats> {
  const query = `query($zone: String!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
    viewer { zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(limit: 50, filter: $filter) { count sum { edgeResponseBytes } dimensions { cacheStatus } }
    } }
  }`;
  const filter: Record<string, unknown> = { datetime_geq: since.toISOString(), datetime_lt: until.toISOString() };
  if (hosts && hosts.length) filter.clientRequestHTTPHost_in = hosts;
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { zone: cfg.zoneId, filter } }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as {
    errors?: { message: string }[] | null;
    data?: { viewer: { zones: { httpRequestsAdaptiveGroups: { count: number; sum: { edgeResponseBytes: number }; dimensions: { cacheStatus: string } }[] }[] } };
  };
  if (data.errors?.length) throw new Error(`Cloudflare analytics error: ${data.errors.map((e) => e.message).join('; ')}`);
  const groups = data.data?.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? [];
  const statuses = groups.map((g) => ({ status: g.dimensions.cacheStatus, requests: g.count, bytes: g.sum.edgeResponseBytes })).sort((a, b) => b.requests - a.requests);
  const total = statuses.reduce((a, s) => a + s.requests, 0);
  const hits = statuses.filter((s) => ['hit', 'stale', 'updating', 'revalidated'].includes(s.status.toLowerCase())).reduce((a, s) => a + s.requests, 0);
  return { source: 'cloudflare', since: since.toISOString(), until: until.toISOString(), statuses, hit_ratio: total ? Math.round((hits / total) * 1000) / 1000 : 0 };
}

export async function verifyCloudflareToken(cfg: CloudflareConfig): Promise<{ name: string; status: string }> {
  const zone = await cf<{ name: string; status: string }>(cfg, `/zones/${encodeURIComponent(cfg.zoneId)}`);
  return { name: zone.name, status: zone.status };
}
