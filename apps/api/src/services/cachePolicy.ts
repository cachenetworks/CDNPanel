import type { File } from '@cdn/database';
import type { Settings } from '../lib/settings.js';
import type { ZoneWithRelations } from '../lib/zones.js';
import { globMatch } from '../lib/glob.js';

export interface CachePolicy {
  /** Browser-facing Cache-Control. */
  cacheControl: string;
  /** Shared-cache directive (CDN-Cache-Control, honoured by Cloudflare and most CDNs); null = not sent. */
  cdnCacheControl: string | null;
  edgeTtl: number;
  browserTtl: number;
  bypass: boolean;
  rule: { id: string; name: string; pattern: string } | null;
  /** Value for the Cache-Tag header. */
  tags: string[];
  source: 'private' | 'file' | 'rule' | 'zone' | 'default';
}

/** Path of a file relative to its zone root (or its absolute library path outside zones). */
export function zoneRelativePath(folderPath: string | null, slug: string, zone: ZoneWithRelations | null): string {
  const full = `${folderPath ?? ''}/${slug}`;
  const root = zone?.rootFolder?.path;
  if (root && (full === root || full.startsWith(`${root}/`))) return full.slice(root.length) || '/';
  return full;
}

export function cacheTagsFor(file: Pick<File, 'id' | 'folderId' | 'cacheTags'>, zone: ZoneWithRelations | null): string[] {
  const tags = [`file:${file.id}`];
  if (file.folderId) tags.push(`folder:${file.folderId}`);
  if (zone) tags.push(`zone:${zone.slug}`, `project:${zone.projectId}`);
  for (const t of file.cacheTags) if (!tags.includes(t)) tags.push(t);
  return tags;
}

export function cachePolicy(input: {
  file: Pick<File, 'id' | 'folderId' | 'cacheTags' | 'cacheControl'>;
  zone: ZoneWithRelations | null;
  relPath: string;
  settings: Settings;
  isPublic: boolean;
}): CachePolicy {
  const { file, zone, relPath, settings, isPublic } = input;
  const tags = cacheTagsFor(file, zone);
  if (!isPublic) {
    return { cacheControl: settings.files.privateCacheControl, cdnCacheControl: 'no-store', edgeTtl: 0, browserTtl: 0, bypass: true, rule: null, tags, source: 'private' };
  }
  if (file.cacheControl) {
    return { cacheControl: file.cacheControl, cdnCacheControl: null, edgeTtl: maxAge(file.cacheControl), browserTtl: maxAge(file.cacheControl), bypass: false, rule: null, tags, source: 'file' };
  }
  const rule = zone?.cacheRules.find((r) => r.enabled && globMatch(r.pattern, relPath)) ?? null;
  const ruleRef = rule ? { id: rule.id, name: rule.name, pattern: rule.pattern } : null;
  if (rule?.bypass) {
    return { cacheControl: 'public, no-cache', cdnCacheControl: 'no-store', edgeTtl: 0, browserTtl: 0, bypass: true, rule: ruleRef, tags, source: 'rule' };
  }
  if (!zone && !rule) {
    // Outside zones the long-standing global default applies to browsers.
    const edge = settings.cache.defaultEdgeTtl;
    return {
      cacheControl: settings.files.defaultCacheControl,
      cdnCacheControl: `max-age=${edge}`,
      edgeTtl: edge,
      browserTtl: maxAge(settings.files.defaultCacheControl),
      bypass: false,
      rule: null,
      tags,
      source: 'default',
    };
  }
  const browserTtl = rule?.browserTtl ?? zone?.browserTtl ?? settings.cache.defaultBrowserTtl;
  const edgeTtl = rule?.edgeTtl ?? zone?.edgeTtl ?? settings.cache.defaultEdgeTtl;
  return {
    cacheControl: browserTtl > 0 ? `public, max-age=${browserTtl}` : 'public, no-cache',
    cdnCacheControl: edgeTtl > 0 ? `max-age=${edgeTtl}` : 'no-store',
    edgeTtl,
    browserTtl,
    bypass: false,
    rule: ruleRef,
    tags,
    source: rule ? 'rule' : 'zone',
  };
}

function maxAge(cc: string): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cc);
  return m ? Number(m[1]) : 0;
}
