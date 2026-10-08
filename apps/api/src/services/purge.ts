import { getPrisma, Prisma, type CachePurge, type File } from '@cdn/database';
import { newId } from '@cdn/shared';
import { env } from '../config/env.js';
import type { AuditContext } from '../lib/audit.js';
import { audit } from '../lib/audit.js';
import { cloudflareConfigFor, purgeCloudflare, type CloudflareConfig, type PurgeRequest } from '../lib/cloudflare.js';
import { baseLogger } from '../lib/logger.js';
import { enqueueEdge } from '../lib/queue.js';
import { getSettings } from '../lib/settings.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { folderPathOf, getZones, zoneForPath, type ZoneWithRelations } from '../lib/zones.js';
import { zoneRelativePath } from './cachePolicy.js';

export const PURGE_TYPES = ['url', 'file', 'folder', 'tag', 'zone', 'everything'] as const;
export type PurgeType = (typeof PURGE_TYPES)[number];

/** Every public URL a file is reachable at (platform URLs + each active zone hostname). */
export function fileEdgeUrls(file: Pick<File, 'id' | 'slug'>, folderPath: string | null, zone: ZoneWithRelations | null): string[] {
  const cdn = env().CDN_URL;
  const urls = [`${cdn}/files/${file.id}`, `${cdn}/p${folderPath ?? ''}/${encodeURIComponent(file.slug)}`];
  for (const d of zone?.domains ?? []) {
    if (d.status !== 'ACTIVE') continue;
    const rel = zoneRelativePath(folderPath, file.slug, zone);
    urls.push(`https://${d.hostname}${rel.split('/').map(encodeURIComponent).join('/')}`, `https://${d.hostname}/files/${file.id}`);
  }
  return [...new Set(urls)];
}

export async function createPurge(input: { zoneId?: string | null; type: PurgeType; targets: string[]; actor: AuditContext }): Promise<CachePurge> {
  const purge = await getPrisma().cachePurge.create({
    data: {
      id: newId('cachePurge'),
      zoneId: input.zoneId ?? null,
      type: input.type,
      targets: input.targets.slice(0, 1000),
      createdById: input.actor.actorType === 'user' ? (input.actor.actorId ?? null) : null,
      createdByLabel: input.actor.actorLabel ?? null,
    },
  });
  await audit(input.actor, 'CACHE_PURGE', { type: 'cache_purge', id: purge.id }, { zone_id: input.zoneId, purge_type: input.type, targets: input.targets.slice(0, 50) });
  await enqueueEdge({ type: 'purge', purgeId: purge.id });
  return purge;
}

/** Called after content changes (replacement, rename, move, visibility, deletion). */
export async function autoPurgeFiles(files: Pick<File, 'id'>[], reason: string): Promise<void> {
  if (files.length === 0) return;
  const settings = await getSettings();
  if (!settings.cache.autoPurge) return;
  try {
    await createPurge({ type: 'file', targets: files.map((f) => f.id), actor: { actorType: 'system', actorLabel: `auto-purge (${reason})` } });
  } catch (err) {
    baseLogger.error({ err }, 'auto purge failed');
  }
}

class PurgePlan {
  private readonly byConfig = new Map<string, { cfg: CloudflareConfig; req: Required<Omit<PurgeRequest, 'everything'>> & { everything: boolean } }>();
  unconfigured = 0;

  add(cfg: CloudflareConfig | null, part: PurgeRequest): void {
    if (!cfg) {
      this.unconfigured++;
      return;
    }
    const key = cfg.zoneId;
    let entry = this.byConfig.get(key);
    if (!entry) {
      entry = { cfg, req: { files: [], tags: [], prefixes: [], hosts: [], everything: false } };
      this.byConfig.set(key, entry);
    }
    entry.req.files.push(...(part.files ?? []));
    entry.req.tags.push(...(part.tags ?? []));
    entry.req.prefixes.push(...(part.prefixes ?? []));
    entry.req.hosts.push(...(part.hosts ?? []));
    entry.req.everything ||= Boolean(part.everything);
  }

  entries() {
    return [...this.byConfig.values()].map((e) => ({
      cfg: e.cfg,
      req: e.req.everything
        ? { everything: true }
        : { files: [...new Set(e.req.files)], tags: [...new Set(e.req.tags)], prefixes: [...new Set(e.req.prefixes)], hosts: [...new Set(e.req.hosts)] },
    }));
  }
}

/** Resolves a purge into Cloudflare requests and executes them (runs in the worker). */
export async function executePurge(purgeId: string): Promise<void> {
  const prisma = getPrisma();
  const purge = await prisma.cachePurge.findUnique({ where: { id: purgeId } });
  if (!purge || purge.status !== 'pending') return;
  const reg = await getZones();
  const zone = purge.zoneId ? (reg.byId.get(purge.zoneId) ?? null) : null;
  const plan = new PurgePlan();
  const cdnHost = new URL(env().CDN_URL).host;

  switch (purge.type) {
    case 'url':
      for (const url of purge.targets) {
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          continue;
        }
        const z = reg.byHost.get(host) ?? zone;
        plan.add(cloudflareConfigFor(z), { files: [url] });
      }
      break;
    case 'file': {
      const files = await prisma.file.findMany({ where: { id: { in: purge.targets } }, select: { id: true, slug: true, folderId: true } });
      for (const f of files) {
        const folderPath = await folderPathOf(f.folderId);
        const z = zoneForPath(reg, folderPath);
        // Tags also cover signed URLs and image variants, whose query strings cannot be enumerated.
        plan.add(cloudflareConfigFor(z), { files: fileEdgeUrls(f, folderPath, z), tags: [`file:${f.id}`] });
      }
      // Deleted files are no longer in the database: purge by tag only.
      for (const id of purge.targets.filter((t) => !files.some((f) => f.id === t))) plan.add(cloudflareConfigFor(zone), { tags: [`file:${id}`] });
      break;
    }
    case 'folder': {
      const folders = await prisma.folder.findMany({ where: { id: { in: purge.targets } } });
      for (const fo of folders) {
        const z = zoneForPath(reg, fo.path);
        const prefixes = [`${cdnHost}/p${fo.path}/`];
        for (const d of z?.domains ?? []) {
          if (d.status !== 'ACTIVE') continue;
          const rel = zoneRelativePath(fo.path, '', z).replace(/\/$/, '');
          prefixes.push(`${d.hostname}${rel}/`);
        }
        plan.add(cloudflareConfigFor(z), { prefixes, tags: [`folder:${fo.id}`] });
      }
      break;
    }
    case 'tag':
      plan.add(cloudflareConfigFor(zone), { tags: purge.targets });
      break;
    case 'zone': {
      const zones = purge.targets.map((id) => reg.byId.get(id)).filter((z): z is ZoneWithRelations => Boolean(z));
      for (const z of zones) {
        const hosts = z.domains.filter((d) => d.status === 'ACTIVE').map((d) => d.hostname);
        plan.add(cloudflareConfigFor(z), { hosts, tags: [`zone:${z.slug}`] });
      }
      break;
    }
    case 'everything': {
      const configs = new Map<string, CloudflareConfig>();
      for (const z of zone ? [zone] : reg.zones) {
        const cfg = cloudflareConfigFor(z);
        if (cfg) configs.set(cfg.zoneId, cfg);
      }
      const global = cloudflareConfigFor(null);
      if (global && !zone) configs.set(global.zoneId, global);
      if (configs.size === 0) plan.add(null, {});
      for (const cfg of configs.values()) plan.add(cfg, { everything: true });
      break;
    }
  }

  const results: Record<string, unknown>[] = [];
  let failures = 0;
  for (const { cfg, req } of plan.entries()) {
    try {
      const r = await purgeCloudflare(cfg, req);
      results.push({ cloudflare_zone: cfg.zoneId, ok: true, api_requests: r.requests, ...req });
    } catch (err) {
      failures++;
      results.push({ cloudflare_zone: cfg.zoneId, ok: false, error: (err as Error).message });
    }
  }
  const status = results.length === 0 ? 'origin_only' : failures === 0 ? (plan.unconfigured > 0 ? 'partial' : 'completed') : failures === results.length ? 'failed' : 'partial';
  await prisma.cachePurge.update({
    where: { id: purge.id },
    data: { status, completedAt: new Date(), edgeResult: { results, unconfigured_targets: plan.unconfigured } as unknown as Prisma.InputJsonValue },
  });
  await emitWebhookEvent('cache.purged', { purge_id: purge.id, type: purge.type, targets: purge.targets.slice(0, 100), status }, { projectId: zone?.projectId });
}

/** Fetches public URLs through the edge so they are cached before visitors ask for them. */
export async function prewarmUrls(urls: string[]): Promise<{ url: string; status: number | null; cache: string | null; ms: number }[]> {
  const out: { url: string; status: number | null; cache: string | null; ms: number }[] = [];
  for (const url of urls.slice(0, 500)) {
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'CDNPanel-Prewarm/1.0' }, signal: AbortSignal.timeout(60_000) });
      // Drain the body so the edge stores the full object.
      if (res.body) for await (const _ of res.body as unknown as AsyncIterable<Uint8Array>) void _;
      out.push({ url, status: res.status, cache: res.headers.get('cf-cache-status'), ms: Date.now() - started });
    } catch {
      out.push({ url, status: null, cache: null, ms: Date.now() - started });
    }
  }
  return out;
}
