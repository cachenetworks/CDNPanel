import dns from 'node:dns/promises';
import { getPrisma, type ZoneDomain } from '@cdn/database';
import { AppError } from '@cdn/shared';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { baseLogger } from '../lib/logger.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { getZones, invalidateZones, normalizeHost } from '../lib/zones.js';

/**
 * Custom domain onboarding:
 *  1. The owner adds TXT  _cdnpanel-challenge.<hostname> = <verification token>
 *  2. …and routes the hostname to this server (CNAME to the CDN host, or a Cloudflare Tunnel public hostname).
 *  3. Verification checks the TXT record; the domain becomes ACTIVE and starts serving the zone.
 *  4. Health checks fetch https://<hostname>/.well-known/cdnpanel/<domain id> through the edge,
 *     which proves routing and a valid TLS certificate end to end.
 */

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export function challengeRecordName(hostname: string): string {
  return `_cdnpanel-challenge.${hostname}`;
}

export function cnameTarget(): string {
  return env().DOMAIN_CNAME_TARGET || new URL(env().CDN_URL).hostname;
}

export function validateHostname(raw: string): string {
  const host = normalizeHost(raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  if (!HOSTNAME_RE.test(host)) throw new AppError('validation_failed', 'Enter a fully-qualified hostname such as assets.example.com.');
  const reserved = [new URL(env().APP_URL).hostname, new URL(env().API_URL).hostname].map((h) => h.toLowerCase());
  if (reserved.includes(host)) throw new AppError('validation_failed', 'The dashboard / API hostname cannot be used as a zone domain.');
  return host;
}

export interface DnsCheck {
  txt: { name: string; expected: string; found: string[]; ok: boolean };
  routing: { cname: string[]; addresses: string[]; expected_cname: string; ok: boolean };
}

export async function inspectDns(domain: Pick<ZoneDomain, 'hostname' | 'verificationToken'>): Promise<DnsCheck> {
  const name = challengeRecordName(domain.hostname);
  const txt = await dns.resolveTxt(name).then((r) => r.map((parts) => parts.join('')), () => [] as string[]);
  const cname = await dns.resolveCname(domain.hostname).catch(() => [] as string[]);
  const addresses = await dns.resolve4(domain.hostname).catch(() => [] as string[]);
  const expected = cnameTarget();
  return {
    txt: { name, expected: domain.verificationToken, found: txt, ok: txt.includes(domain.verificationToken) },
    // Proxied Cloudflare records are flattened, so any resolvable address counts as routed.
    routing: { cname, addresses, expected_cname: expected, ok: cname.map((c) => c.toLowerCase().replace(/\.$/, '')).includes(expected) || addresses.length > 0 },
  };
}

/** HTTPS probe through the public edge. */
export async function probeDomain(domain: Pick<ZoneDomain, 'id' | 'hostname' | 'verificationToken'>): Promise<{ ok: boolean; tls: 'active' | 'error'; status: number | null; error: string | null; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`https://${domain.hostname}/.well-known/cdnpanel/${domain.id}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'CDNPanel-HealthCheck/1.0' } });
    const body = (await res.text()).trim();
    const ok = res.ok && body === domain.verificationToken;
    return { ok, tls: 'active', status: res.status, error: ok ? null : `Unexpected response (HTTP ${res.status}); is the hostname routed to this server?`, ms: Date.now() - started };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const tlsError = Boolean(cause?.code && /CERT|TLS|SSL/i.test(cause.code));
    return { ok: false, tls: tlsError ? 'error' : 'active', status: null, error: cause?.message ?? (err as Error).message, ms: Date.now() - started };
  }
}

export async function verifyDomain(domain: ZoneDomain, actorLabel = 'domain-verifier'): Promise<{ domain: ZoneDomain; dns: DnsCheck | null }> {
  const prisma = getPrisma();
  if (env().DOMAIN_VERIFICATION_DISABLED) {
    const updated = await prisma.zoneDomain.update({ where: { id: domain.id }, data: { status: 'ACTIVE', verifiedAt: domain.verifiedAt ?? new Date(), lastCheckedAt: new Date(), lastError: null } });
    invalidateZones();
    return { domain: updated, dns: null };
  }
  const check = await inspectDns(domain);
  if (!check.txt.ok) {
    const updated = await prisma.zoneDomain.update({
      where: { id: domain.id },
      data: { lastCheckedAt: new Date(), lastError: `TXT record ${check.txt.name} not found (found: ${check.txt.found.join(', ') || 'nothing'})` },
    });
    return { domain: updated, dns: check };
  }
  const probe = await probeDomain(domain);
  const wasActive = domain.status === 'ACTIVE';
  const updated = await prisma.zoneDomain.update({
    where: { id: domain.id },
    data: {
      status: 'ACTIVE',
      verifiedAt: domain.verifiedAt ?? new Date(),
      lastCheckedAt: new Date(),
      tlsStatus: probe.tls,
      healthStatus: probe.ok ? 'healthy' : 'unhealthy',
      lastError: probe.error,
    },
  });
  invalidateZones();
  if (!wasActive) {
    await audit({ actorType: 'system', actorLabel }, 'DOMAIN_VERIFIED', { type: 'domain', id: domain.id }, { hostname: domain.hostname });
    const zone = (await getZones()).byId.get(domain.zoneId);
    await emitWebhookEvent('domain.verified', { domain_id: domain.id, hostname: domain.hostname, zone_id: domain.zoneId }, { projectId: zone?.projectId });
  }
  return { domain: updated, dns: check };
}

/** Periodic job: verifies pending domains and health-checks active ones. */
export async function checkDomains(): Promise<void> {
  const prisma = getPrisma();
  const domains = await prisma.zoneDomain.findMany({ where: { OR: [{ status: 'ACTIVE' }, { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } }] } });
  for (const d of domains) {
    try {
      if (d.status === 'PENDING') {
        await verifyDomain(d);
        continue;
      }
      if (env().DOMAIN_VERIFICATION_DISABLED) continue;
      const probe = await probeDomain(d);
      const health = probe.ok ? 'healthy' : 'unhealthy';
      await prisma.zoneDomain.update({ where: { id: d.id }, data: { healthStatus: health, tlsStatus: probe.tls, lastCheckedAt: new Date(), lastError: probe.error } });
      if (health === 'unhealthy' && d.healthStatus !== 'unhealthy') {
        const zone = (await getZones()).byId.get(d.zoneId);
        await emitWebhookEvent('domain.unhealthy', { domain_id: d.id, hostname: d.hostname, zone_id: d.zoneId, error: probe.error }, { projectId: zone?.projectId });
      }
    } catch (err) {
      baseLogger.warn({ err, domain: d.hostname }, 'domain check failed');
    }
  }
  invalidateZones();
}
