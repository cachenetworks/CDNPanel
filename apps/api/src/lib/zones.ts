import { getPrisma, type CacheRule, type SecurityRule, type Zone, type ZoneDomain } from '@cdn/database';

/**
 * In-process zone registry. Zones are few and read on every delivery request, so the full set
 * (with domains, cache rules and security rules) is cached briefly and refreshed in the background.
 * Mutating routes call `invalidateZones()`; other processes pick changes up within the TTL.
 */

export type ZoneWithRelations = Zone & {
  domains: ZoneDomain[];
  cacheRules: CacheRule[];
  securityRules: SecurityRule[];
  rootFolder: { id: string; path: string } | null;
};

export interface ZoneRegistry {
  zones: ZoneWithRelations[];
  byId: Map<string, ZoneWithRelations>;
  /** Active (verified) hostnames only. */
  byHost: Map<string, ZoneWithRelations>;
  /** Global security rules (zoneId = null), sorted by priority. */
  globalRules: SecurityRule[];
}

const TTL_MS = 10_000;
let cache: { at: number; value: ZoneRegistry } | null = null;
let loading: Promise<ZoneRegistry> | null = null;

async function load(): Promise<ZoneRegistry> {
  const prisma = getPrisma();
  const [zones, globalRules] = await Promise.all([
    prisma.zone.findMany({
      include: {
        domains: true,
        cacheRules: { where: { enabled: true }, orderBy: { priority: 'asc' } },
        securityRules: { where: { enabled: true }, orderBy: { priority: 'asc' } },
        rootFolder: { select: { id: true, path: true } },
      },
    }),
    prisma.securityRule.findMany({ where: { zoneId: null, enabled: true }, orderBy: { priority: 'asc' } }),
  ]);
  const byId = new Map(zones.map((z) => [z.id, z]));
  const byHost = new Map<string, ZoneWithRelations>();
  for (const z of zones) for (const d of z.domains) if (d.status === 'ACTIVE') byHost.set(d.hostname, z);
  return { zones, byId, byHost, globalRules };
}

export async function getZones(): Promise<ZoneRegistry> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (!loading) {
    loading = load()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        loading = null;
      });
  }
  // Serve a stale registry while refreshing rather than blocking delivery.
  if (cache) return cache.value;
  return loading;
}

export function invalidateZones(): void {
  cache = null;
}

/** Normalises a Host header: lower case, port and trailing dot removed. */
export function normalizeHost(host: string | undefined): string {
  if (!host) return '';
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h; // IPv6 literal: never a zone hostname
  const colon = h.lastIndexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  return h.replace(/\.$/, '');
}

export async function zoneForHost(host: string | undefined): Promise<ZoneWithRelations | null> {
  const h = normalizeHost(host);
  if (!h) return null;
  const reg = await getZones();
  const zone = reg.byHost.get(h);
  return zone && zone.enabled ? zone : null;
}

/** The zone whose root folder is the deepest ancestor (or self) of `folderPath`. */
export function zoneForPath(reg: ZoneRegistry, folderPath: string | null): ZoneWithRelations | null {
  if (!folderPath) return null;
  let best: ZoneWithRelations | null = null;
  for (const z of reg.zones) {
    const root = z.rootFolder?.path;
    if (!root) continue;
    if (folderPath === root || folderPath.startsWith(`${root}/`)) {
      if (!best || root.length > (best.rootFolder?.path.length ?? 0)) best = z;
    }
  }
  return best;
}

// Folder paths are needed to attribute files to zones; cache them briefly.
const folderPaths = new Map<string, { at: number; path: string | null }>();

export async function folderPathOf(folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const hit = folderPaths.get(folderId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.path;
  const folder = await getPrisma().folder.findUnique({ where: { id: folderId }, select: { path: true } });
  const path = folder?.path ?? null;
  if (folderPaths.size > 10_000) folderPaths.clear();
  folderPaths.set(folderId, { at: Date.now(), path });
  return path;
}

export async function zoneForFolder(folderId: string | null): Promise<ZoneWithRelations | null> {
  if (!folderId) return null;
  return zoneForPath(await getZones(), await folderPathOf(folderId));
}

/** Root folder paths of a project's zones (API keys bound to a project are confined to these). */
export async function projectRootPaths(projectId: string): Promise<string[]> {
  const reg = await getZones();
  return reg.zones.filter((z) => z.projectId === projectId && z.rootFolder).map((z) => z.rootFolder!.path);
}

export function pathWithin(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Public base URL of a zone: its primary active domain, else the platform CDN URL. */
export function zoneBaseUrl(zone: ZoneWithRelations | null, fallback: string): string {
  if (!zone) return fallback;
  const active = zone.domains.filter((d) => d.status === 'ACTIVE');
  const primary = active.find((d) => d.isPrimary) ?? active[0];
  return primary ? `https://${primary.hostname}` : fallback;
}
