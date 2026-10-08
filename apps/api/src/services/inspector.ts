import { getPrisma, type File } from '@cdn/database';
import { isActiveContentType, isValidId, sha256Hex, verifySignedFileUrl } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { getSettings } from '../lib/settings.js';
import { folderPathOf, getZones, normalizeHost, zoneForPath, type ZoneWithRelations } from '../lib/zones.js';
import { cachePolicy, zoneRelativePath } from './cachePolicy.js';
import { evaluateRules, zoneAccessCheck, type RequestFacts } from './edgeSecurity.js';
import { canonicalTransform, parseTransform, resolveFormat, TRANSFORMABLE, variantHash, verifyTransformSignature } from './images.js';
import { providerMap, sourceCandidates } from './replication.js';
import { shareState } from './shares.js';
import { verifyMediaToken } from './media.js';

/**
 * Asset Inspector: explains, stage by stage, how the platform would answer a CDN URL —
 * host/zone resolution, file lookup, edge security, authorization, storage source selection,
 * cache policy, content handling, transformations — and optionally performs a live request.
 */

export type StepStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface InspectStep {
  stage: string;
  status: StepStatus;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface InspectOptions {
  url: string;
  country?: string | null;
  referer?: string;
  ip?: string;
  /** Pretend the visitor has an API key / staff session (affects private files). */
  authenticated?: boolean;
  live?: boolean;
}

interface Route {
  kind: 'file' | 'path' | 'zone_path' | 'image' | 'media' | 'share' | 'unknown';
  fileId?: string;
  segments?: string[];
  mediaKind?: string;
  mediaToken?: string;
  shareToken?: string;
}

function matchRoute(pathname: string, onZoneHost: boolean): Route {
  const parts = pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts[0] === 'files' && parts[1]) return { kind: 'file', fileId: parts[1] };
  if (parts[0] === 'p' && parts.length > 1) return { kind: 'path', segments: parts.slice(1) };
  if (parts[0] === 'img' && parts[1]) return { kind: 'image', fileId: parts[1] };
  if (parts[0] === 'media' && parts.length >= 5) return { kind: 'media', fileId: parts[1], mediaToken: parts[2], mediaKind: parts[3] };
  if (parts[0] === 's' && parts[1]) return { kind: 'share', shareToken: parts[1] };
  if (onZoneHost && parts.length) return { kind: 'zone_path', segments: parts };
  return { kind: 'unknown' };
}

async function fileByPath(base: string, segments: string[]): Promise<File | null> {
  const parts = [...segments];
  const slug = parts.pop()!;
  const folderPath = `${base}${parts.length ? `/${parts.join('/')}` : ''}`;
  let folderId: string | null = null;
  if (folderPath) {
    const folder = await getPrisma().folder.findUnique({ where: { path: folderPath } });
    if (!folder) return null;
    folderId = folder.id;
  }
  return getPrisma().file.findFirst({ where: { folderId, slug, deletedAt: null }, orderBy: { createdAt: 'desc' } });
}

export async function inspectUrl(opts: InspectOptions): Promise<{ url: string; verdict: 'served' | 'denied' | 'not_found' | 'challenge'; steps: InspectStep[]; headers: Record<string, string>; live?: unknown }> {
  const steps: InspectStep[] = [];
  const headers: Record<string, string> = {};
  const started = Date.now();
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    return { url: opts.url, verdict: 'not_found', steps: [{ stage: 'parse', status: 'fail', title: 'Not a valid URL' }], headers };
  }
  const e = env();
  const settings = await getSettings();
  const reg = await getZones();
  const host = normalizeHost(url.host);
  const platformHosts = [e.CDN_URL, e.APP_URL, e.API_URL].map((u) => normalizeHost(new URL(u).host));
  const hostZone = reg.byHost.get(host) ?? null;
  const pendingDomain = hostZone ? null : reg.zones.flatMap((z) => z.domains).find((d) => d.hostname === host);

  // 1. Host
  if (hostZone) steps.push({ stage: 'host', status: hostZone.enabled ? 'ok' : 'fail', title: `Custom domain of zone “${hostZone.name}”`, detail: hostZone.enabled ? 'Paths resolve relative to the zone root folder; only this zone’s files are served.' : 'The zone is disabled.', data: { zone_id: hostZone.id, root: hostZone.rootFolder?.path ?? '/' } });
  else if (pendingDomain) steps.push({ stage: 'host', status: 'fail', title: `Domain ${host} is ${pendingDomain.status.toLowerCase()}`, detail: pendingDomain.lastError ?? 'Verify the domain before it can serve traffic.' });
  else if (platformHosts.includes(host)) steps.push({ stage: 'host', status: 'ok', title: 'Platform CDN hostname', detail: `${host} serves every zone through /files, /p, /img, /media and /s URLs.` });
  else steps.push({ stage: 'host', status: 'warn', title: `Unknown host ${host}`, detail: 'This hostname is not attached to any zone; requests would not reach the CDN.' });

  // 2. Route
  const route = matchRoute(url.pathname, Boolean(hostZone));
  const routeTitles: Record<Route['kind'], string> = {
    file: 'File by id (/files/:id)',
    path: 'Friendly path (/p/…)',
    zone_path: 'Zone-relative path on a custom domain',
    image: 'Image transformation (/img/:id)',
    media: 'Media rendition (/media/…)',
    share: 'Share link (/s/:token)',
    unknown: 'No delivery route matches',
  };
  steps.push({ stage: 'route', status: route.kind === 'unknown' ? 'fail' : 'ok', title: routeTitles[route.kind], data: { path: url.pathname } });
  if (route.kind === 'unknown') return { url: opts.url, verdict: 'not_found', steps, headers };

  // 3. File lookup
  let file: File | null = null;
  let share = null;
  if (route.kind === 'file' || route.kind === 'image' || route.kind === 'media') {
    file = route.fileId && isValidId('file', route.fileId) ? await getPrisma().file.findUnique({ where: { id: route.fileId } }) : null;
  } else if (route.kind === 'path') {
    if (!settings.files.enableFriendlyPaths) steps.push({ stage: 'file', status: 'fail', title: 'Friendly paths are disabled in settings' });
    else file = await fileByPath('', route.segments!);
  } else if (route.kind === 'zone_path') {
    file = await fileByPath(hostZone!.rootFolder?.path ?? '', route.segments!);
  } else if (route.kind === 'share') {
    share = /^[0-9A-Za-z]{16,64}$/.test(route.shareToken!) ? await getPrisma().shareLink.findUnique({ where: { tokenHash: sha256Hex(route.shareToken!) }, include: { file: true } }) : null;
    if (share) {
      file = share.file;
      const state = shareState(share);
      steps.push({ stage: 'share', status: state === 'active' ? 'ok' : 'fail', title: `Share link is ${state}`, data: { password: Boolean(share.passwordHash), require_email: share.requireEmail, downloads: share.downloadCount, max_downloads: share.maxDownloads, expires_at: share.expiresAt?.toISOString() ?? null, one_time: share.oneTime } });
    } else steps.push({ stage: 'share', status: 'fail', title: 'Share token not found' });
  }
  if (!file) {
    steps.push({ stage: 'file', status: 'fail', title: 'File not found', detail: 'No file matches this URL → 404.' });
    return { url: opts.url, verdict: 'not_found', steps, headers };
  }
  const fileOk = file.status === 'READY' && !file.deletedAt;
  steps.push({
    stage: 'file',
    status: fileOk ? 'ok' : 'fail',
    title: `${file.name}`,
    detail: file.deletedAt ? 'The file is in the recycle bin → 404.' : file.status !== 'READY' ? `The file is ${file.status.toLowerCase()} → 404.` : undefined,
    data: { id: file.id, version: file.version, size: Number(file.size), sha256: file.sha256, visibility: file.visibility, status: file.status, cache_tags: file.cacheTags },
  });
  if (!fileOk) return { url: opts.url, verdict: 'not_found', steps, headers };

  // 4. Zone
  const folderPath = await folderPathOf(file.folderId);
  const zone: ZoneWithRelations | null = zoneForPath(reg, folderPath);
  if (hostZone && hostZone.id !== zone?.id) {
    steps.push({ stage: 'zone', status: 'fail', title: 'File belongs to a different zone', detail: 'Custom domains only serve their own zone → 404.' });
    return { url: opts.url, verdict: 'not_found', steps, headers };
  }
  steps.push({ stage: 'zone', status: zone ? 'ok' : 'info', title: zone ? `Zone “${zone.name}”` : 'Not in any zone (global defaults apply)', data: zone ? { id: zone.id, project_id: zone.projectId, strategy: zone.replicationStrategy, edge_ttl: zone.edgeTtl, browser_ttl: zone.browserTtl } : { folder: folderPath ?? '/' } });

  // 5. Edge security
  const facts: RequestFacts = { ip: opts.ip ?? '203.0.113.10', country: opts.country ?? null, asn: null, path: url.pathname, method: 'GET', host, user_agent: 'Mozilla/5.0 (inspector)', referer: opts.referer ?? '', requests_per_minute: 1 };
  const zoneCheck = zoneAccessCheck(zone, facts, normalizeHost(new URL(e.APP_URL).host));
  if (zoneCheck.outcome === 'block') {
    steps.push({ stage: 'security', status: 'fail', title: 'Blocked by zone restrictions', detail: zoneCheck.reason });
    return { url: opts.url, verdict: 'denied', steps, headers };
  }
  const rules = await evaluateRules([...(zone?.securityRules ?? []), ...reg.globalRules], facts, { dryRun: true });
  if (rules.outcome !== 'allow') {
    steps.push({ stage: 'security', status: rules.outcome === 'challenge' ? 'warn' : 'fail', title: rules.reason, detail: rules.outcome === 'challenge' ? 'Visitors see a browser check first.' : undefined });
    if (rules.outcome === 'block') return { url: opts.url, verdict: 'denied', steps, headers };
  } else steps.push({ stage: 'security', status: 'ok', title: 'Edge security passed', detail: `${zoneCheck.reason}; ${rules.reason}.`, data: { country: facts.country, referer: facts.referer || null } });

  // 6. Authorization
  const q = Object.fromEntries(url.searchParams.entries());
  let authOk = true;
  let authTitle = '';
  if (route.kind === 'share') {
    authTitle = share?.passwordHash || share?.requireEmail ? 'Share link unlock required (password / email), then download' : 'Share link grants access';
  } else if (route.kind === 'media') {
    authOk = route.mediaToken === 'pub' ? file.visibility === 'PUBLIC' : verifyMediaToken(file.id, route.mediaToken!);
    authTitle = authOk ? 'Media token valid' : 'Media token invalid or expired';
  } else if (q.sig !== undefined || q.expires !== undefined) {
    const res = verifySignedFileUrl(getKeyring(), file.id, q);
    authOk = res.ok;
    authTitle = res.ok ? `Valid signed URL (expires ${new Date(Number(q.expires) * 1000).toISOString()})` : `Signed URL rejected: ${res.reason}`;
  } else if (file.visibility === 'PUBLIC') authTitle = 'Public file — no credentials needed';
  else if (file.visibility === 'SIGNED_URL_ONLY') {
    authOk = false;
    authTitle = 'Signed URL required — the URL carries no signature';
  } else {
    authOk = Boolean(opts.authenticated);
    authTitle = authOk ? `${file.visibility.toLowerCase()} file — allowed for the assumed credentials` : `${file.visibility.toLowerCase()} file — needs an API key, staff session, signed URL or signed cookie`;
  }
  steps.push({ stage: 'auth', status: authOk ? 'ok' : 'fail', title: authTitle });
  if (!authOk) return { url: opts.url, verdict: 'denied', steps, headers };

  // 7. Transformation
  let mime = file.mimeType;
  if (route.kind === 'image') {
    if (!TRANSFORMABLE.has(file.mimeType)) {
      steps.push({ stage: 'transform', status: 'fail', title: `${file.mimeType} cannot be transformed` });
      return { url: opts.url, verdict: 'denied', steps, headers };
    }
    try {
      const p = parseTransform(q, settings);
      const canonical = canonicalTransform(p);
      const mustSign = zone ? zone.requireSignedTransforms : settings.images.requireSignedTransforms;
      const signed = verifyTransformSignature(file.id, canonical, q.s);
      const format = resolveFormat(p, file.mimeType, 'image/avif,image/webp,*/*');
      const variant = await getPrisma().imageVariant.findUnique({ where: { fileId_paramsHash: { fileId: file.id, paramsHash: variantHash(file, canonical, format) } } });
      mime = `image/${format}`;
      steps.push({
        stage: 'transform',
        status: mustSign && !signed ? 'fail' : 'ok',
        title: mustSign && !signed ? 'Transformation signature missing or invalid → 403' : `Transform ${canonical || '(no-op)'} → ${format}`,
        detail: variant ? `Variant cached at origin (${Number(variant.size)} bytes, ${Number(variant.hits)} hits).` : 'Variant not generated yet — the first request renders it (variant MISS).',
        data: { canonical, signed, required: mustSign, format_for_modern_browsers: format },
      });
      if (mustSign && !signed) return { url: opts.url, verdict: 'denied', steps, headers };
    } catch (err) {
      steps.push({ stage: 'transform', status: 'fail', title: (err as Error).message });
      return { url: opts.url, verdict: 'denied', steps, headers };
    }
  }

  // 8. Storage
  const candidates = await sourceCandidates(file, zone, facts.country);
  const providers = await providerMap();
  steps.push({
    stage: 'storage',
    status: providers.get(candidates[0]!.providerId)?.healthStatus === 'unhealthy' ? 'warn' : 'ok',
    title: `Served from ${providers.get(candidates[0]!.providerId)?.name ?? candidates[0]!.providerId} (${candidates[0]!.role})`,
    detail: candidates.length > 1 ? `Failover order: ${candidates.map((c) => providers.get(c.providerId)?.name ?? c.providerId).join(' → ')}` : undefined,
    data: { delivery_mode: e.DELIVERY_MODE, candidates: candidates.map((c) => ({ provider: providers.get(c.providerId)?.name, kind: providers.get(c.providerId)?.kind, region: providers.get(c.providerId)?.region, role: c.role, health: providers.get(c.providerId)?.healthStatus })) },
  });

  // 9. Cache
  const isPublic = file.visibility === 'PUBLIC' && route.kind !== 'share';
  const policy = cachePolicy({ file, zone, relPath: zoneRelativePath(folderPath, file.slug, zone), settings, isPublic });
  steps.push({
    stage: 'cache',
    status: policy.bypass ? 'info' : 'ok',
    title: policy.bypass ? 'Not cached at the edge' : `Edge TTL ${policy.edgeTtl}s · browser TTL ${policy.browserTtl}s`,
    detail: policy.rule ? `Cache rule “${policy.rule.name}” (${policy.rule.pattern})` : `Source: ${policy.source}`,
    data: { tags: policy.tags },
  });

  // 10. Content handling
  const active = isActiveContentType(file.mimeType);
  steps.push({
    stage: 'content',
    status: active ? 'warn' : 'ok',
    title: `Content-Type ${mime}`,
    detail: active ? 'Active content (HTML / SVG / JS …) is sandboxed and served as an attachment.' : file.forceDownload ? 'Always served as an attachment.' : 'Served inline.',
  });

  headers['Content-Type'] = mime;
  headers['Cache-Control'] = policy.cacheControl;
  if (policy.cdnCacheControl) headers['CDN-Cache-Control'] = policy.cdnCacheControl;
  if (isPublic) headers['Cache-Tag'] = policy.tags.join(',');
  headers.ETag = `"${file.sha256 ?? file.id}"`;
  headers['Accept-Ranges'] = 'bytes';
  if (zone) headers['X-CDN-Zone'] = zone.slug;
  headers['X-Content-Type-Options'] = 'nosniff';

  let live: unknown;
  if (opts.live) {
    const t0 = Date.now();
    try {
      const res = await fetch(opts.url, { method: 'GET', headers: { Range: 'bytes=0-0', 'User-Agent': 'CDNPanel-Inspector/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const ttfb = Date.now() - t0;
      await res.arrayBuffer().catch(() => undefined);
      live = { status: res.status, ttfb_ms: ttfb, total_ms: Date.now() - t0, headers: Object.fromEntries(res.headers.entries()), edge_cache: res.headers.get('cf-cache-status') };
    } catch (err) {
      live = { error: (err as Error).message, total_ms: Date.now() - t0 };
    }
  }
  steps.push({ stage: 'timing', status: 'info', title: `Analysis took ${Date.now() - started} ms` });
  return { url: opts.url, verdict: rules.outcome === 'challenge' ? 'challenge' : 'served', steps, headers, live };
}
