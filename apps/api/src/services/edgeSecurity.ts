import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma, type IpBan, type SecurityRule } from '@cdn/database';
import { AppError, hmacSha256, newId, randomToken, safeEqual } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { ipMatchesAny } from '../lib/ip.js';
import { baseLogger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
import { getSettings } from '../lib/settings.js';
import { getZones, normalizeHost, type ZoneWithRelations } from '../lib/zones.js';

/**
 * Edge security for delivery requests, evaluated in this order:
 *   1. IP bans (manual, rule-created and abuse-created; also enforced for API requests)
 *   2. Zone geo restrictions (country allow/block lists) and ASN blocks
 *   3. Zone hotlink protection (Referer allowlist)
 *   4. WAF-style security rules: zone rules, then global rules, by priority.
 *      The first ALLOW / BLOCK / CHALLENGE / BAN match decides; LOG only records a hit.
 */

// ─── Rule model ─────────────────────────────────────────────────────────────

export const RULE_FIELDS = ['ip', 'country', 'asn', 'path', 'method', 'host', 'user_agent', 'referer', 'requests_per_minute'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export const RULE_OPS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'matches', 'gt', 'lt', 'in_cidr', 'not_in_cidr'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string | number | string[];
}

export interface RequestFacts {
  ip: string;
  country: string | null;
  asn: number | null;
  path: string;
  method: string;
  host: string;
  user_agent: string;
  referer: string;
  /** Lazily computed (needs Redis). */
  requests_per_minute?: number;
}

const MAX_REGEX = 200;
const regexCache = new Map<string, RegExp | null>();
function safeRegex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  try {
    // Reject nested quantifiers, the common catastrophic-backtracking shape.
    if (src.length <= MAX_REGEX && !/(\([^)]*[+*][^)]*\))[+*{]/.test(src)) re = new RegExp(src, 'i');
  } catch {
    re = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(src, re);
  return re;
}

export function conditionMatches(c: RuleCondition, facts: RequestFacts): boolean {
  const raw = facts[c.field];
  const actual = raw === null || raw === undefined ? '' : raw;
  const list = Array.isArray(c.value) ? c.value.map(String) : String(c.value).split(',').map((s) => s.trim()).filter(Boolean);
  const a = String(actual).toLowerCase();
  const v = String(Array.isArray(c.value) ? c.value[0] ?? '' : c.value).toLowerCase();
  switch (c.op) {
    case 'eq':
      return a === v;
    case 'neq':
      return a !== v;
    case 'in':
      return list.some((x) => x.toLowerCase() === a);
    case 'not_in':
      return !list.some((x) => x.toLowerCase() === a);
    case 'contains':
      return a.includes(v);
    case 'not_contains':
      return !a.includes(v);
    case 'starts_with':
      return a.startsWith(v);
    case 'matches': {
      const re = safeRegex(String(c.value));
      return re ? re.test(String(actual)) : false;
    }
    case 'gt':
      return Number(actual) > Number(c.value);
    case 'lt':
      return Number(actual) < Number(c.value);
    case 'in_cidr':
      return c.field === 'ip' && ipMatchesAny(facts.ip, list);
    case 'not_in_cidr':
      return c.field === 'ip' && !ipMatchesAny(facts.ip, list);
  }
}

export function parseConditions(json: unknown): RuleCondition[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (c): c is RuleCondition =>
      typeof c === 'object' && c !== null && (RULE_FIELDS as readonly string[]).includes((c as RuleCondition).field) && (RULE_OPS as readonly string[]).includes((c as RuleCondition).op),
  );
}

export function factsFor(req: FastifyRequest): RequestFacts {
  const e = env();
  let asn: number | null = null;
  if (e.ASN_HEADER) {
    const h = req.headers[e.ASN_HEADER.toLowerCase()];
    const n = Number(Array.isArray(h) ? h[0] : h);
    if (Number.isInteger(n) && n > 0) asn = n;
  }
  return {
    ip: req.clientIp,
    country: req.country,
    asn,
    path: req.url.split('?')[0]!,
    method: req.method,
    host: normalizeHost(req.headers.host),
    user_agent: String(req.headers['user-agent'] ?? ''),
    referer: String(req.headers.referer ?? ''),
  };
}

// ─── IP bans ────────────────────────────────────────────────────────────────

let bans: { at: number; rows: IpBan[] } | null = null;
const BAN_TTL_MS = 15_000;

export function invalidateBans(): void {
  bans = null;
}

async function activeBans(): Promise<IpBan[]> {
  if (bans && Date.now() - bans.at < BAN_TTL_MS) return bans.rows;
  const rows = await getPrisma().ipBan.findMany({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
  bans = { at: Date.now(), rows };
  return rows;
}

export async function isBanned(ip: string): Promise<boolean> {
  if (!ip) return false;
  // Rule- and abuse-created bans are mirrored to Redis for immediate effect across processes.
  if (await getRedis().exists(`ban:${ip}`)) return true;
  const rows = await activeBans();
  return rows.length > 0 && rows.some((b) => (!b.expiresAt || b.expiresAt > new Date()) && ipMatchesAny(ip, [b.cidr]));
}

export async function banIp(ip: string, minutes: number | null, reason: string, source: 'manual' | 'rule' | 'abuse', createdById: string | null = null): Promise<IpBan> {
  const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : null;
  const ban = await getPrisma().ipBan.create({ data: { id: newId('ipBan'), cidr: ip, reason: reason.slice(0, 500), source, expiresAt, createdById } });
  if (!ip.includes('/')) {
    if (minutes) await getRedis().set(`ban:${ip}`, '1', 'EX', minutes * 60);
    else await getRedis().set(`ban:${ip}`, '1');
  }
  invalidateBans();
  void securityEvent('IP_BANNED', { ip, severity: 'warning', details: { reason, source, minutes } });
  return ban;
}

export async function unbanIp(ban: IpBan): Promise<void> {
  await getPrisma().ipBan.delete({ where: { id: ban.id } });
  if (!ban.cidr.includes('/')) await getRedis().del(`ban:${ban.cidr}`);
  invalidateBans();
}

// ─── Rule hit counters (buffered) ───────────────────────────────────────────

const hits = new Map<string, number>();
let hitTimer: NodeJS.Timeout | null = null;

function recordHit(ruleId: string): void {
  hits.set(ruleId, (hits.get(ruleId) ?? 0) + 1);
  if (!hitTimer) {
    hitTimer = setInterval(() => void flushRuleHits(), 5000);
    hitTimer.unref();
  }
}

export async function flushRuleHits(): Promise<void> {
  if (hits.size === 0) return;
  const entries = [...hits.entries()];
  hits.clear();
  const prisma = getPrisma();
  await Promise.all(
    entries.map(([id, n]) => prisma.securityRule.updateMany({ where: { id }, data: { hits: { increment: n }, lastHitAt: new Date() } }).catch(() => undefined)),
  );
}

// ─── Browser challenge (proof of work) ──────────────────────────────────────

const CHALLENGE_COOKIE = 'cdn_chl';
const POW_DIFFICULTY = 4; // leading zero hex digits (~65k SHA-256 hashes in the browser)

function ipTag(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

function challengeMac(payload: string): string {
  return hmacSha256(getKeyring().subkey('challenge'), payload).toString('base64url');
}

/** A passed challenge is bound to the client IP and expires. */
export function challengePassed(req: FastifyRequest): boolean {
  const raw = req.cookies?.[CHALLENGE_COOKIE];
  if (!raw) return false;
  const [exp, tag, mac] = raw.split('.');
  if (!exp || !tag || !mac || Number(exp) < Date.now() / 1000) return false;
  return tag === ipTag(req.clientIp) && safeEqual(mac, challengeMac(`pass.${exp}.${tag}`));
}

export function issueChallengeNonce(ip: string): string {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `nonce.${exp}.${ipTag(ip)}.${randomToken(8)}`;
  return `${payload}.${challengeMac(payload)}`;
}

export async function verifyChallenge(req: FastifyRequest, reply: FastifyReply, nonce: string, counter: string): Promise<boolean> {
  const parts = nonce.split('.');
  if (parts.length !== 5 || parts[0] !== 'nonce') return false;
  const payload = parts.slice(0, 4).join('.');
  if (!safeEqual(parts[4]!, challengeMac(payload))) return false;
  if (Number(parts[1]) < Date.now() / 1000 || parts[2] !== ipTag(req.clientIp)) return false;
  if (!/^\d{1,12}$/.test(counter)) return false;
  const digest = createHash('sha256').update(`${nonce}:${counter}`).digest('hex');
  if (!digest.startsWith('0'.repeat(POW_DIFFICULTY))) return false;
  // Each nonce is single-use.
  const fresh = await getRedis().set(`chl:${parts[3]}`, '1', 'EX', 600, 'NX');
  if (!fresh) return false;
  const settings = await getSettings();
  const exp = Math.floor(Date.now() / 1000) + settings.security.challengeTtlMinutes * 60;
  const tag = ipTag(req.clientIp);
  reply.setCookie(CHALLENGE_COOKIE, `${exp}.${tag}.${challengeMac(`pass.${exp}.${tag}`)}`, {
    httpOnly: true,
    secure: env().cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: settings.security.challengeTtlMinutes * 60,
  });
  return true;
}

export function sendChallengePage(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const nonce = issueChallengeNonce(req.clientIp);
  const scriptNonce = randomToken(16);
  const back = req.url.startsWith('/') && !req.url.startsWith('//') ? req.url : '/';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Checking your browser</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f8;color:#222}main{text-align:center;max-width:28rem;padding:2rem}p{color:#666}</style></head>
<body><main><h1>Checking your browser…</h1><p id="s">This takes a moment. Please keep this page open.</p><noscript><p>JavaScript is required to continue.</p></noscript></main>
<script nonce="${scriptNonce}">(async()=>{const n=${JSON.stringify(nonce)},b=${JSON.stringify(back)},e=new TextEncoder();for(let i=0;i<5e7;i++){const h=new Uint8Array(await crypto.subtle.digest('SHA-256',e.encode(n+':'+i)));if(h[0]===0&&h[1]===0){const r=await fetch('/_challenge/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:n,counter:String(i)}),credentials:'same-origin'});if(r.ok){location.replace(b);return}break}}document.getElementById('s').textContent='Verification failed. Reload the page to try again.'})();</script>
</body></html>`;
  return reply
    .code(403)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`)
    .header('X-CDN-Challenge', '1')
    .send(html);
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export interface EdgeDecision {
  outcome: 'allow' | 'block' | 'challenge';
  reason: string;
  ruleId?: string;
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) || host === p.slice(2);
  return host === p;
}

async function requestsPerMinute(ip: string): Promise<number> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rpm:${ip}:${minute}`;
  const redis = getRedis();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 120);
  return n;
}

/** Pure zone-level checks (geo, ASN, hotlink). Exported for the asset inspector. */
export function zoneAccessCheck(zone: ZoneWithRelations | null, facts: RequestFacts, panelHost: string): EdgeDecision {
  if (!zone) return { outcome: 'allow', reason: 'no zone restrictions' };
  if (facts.country) {
    if (zone.allowedCountries.length > 0 && !zone.allowedCountries.includes(facts.country)) return { outcome: 'block', reason: `country ${facts.country} not in the zone allowlist` };
    if (zone.blockedCountries.includes(facts.country)) return { outcome: 'block', reason: `country ${facts.country} is blocked for this zone` };
  }
  if (facts.asn !== null && zone.blockedAsns.includes(facts.asn)) return { outcome: 'block', reason: `AS${facts.asn} is blocked for this zone` };
  if (zone.allowedReferrers.length > 0) {
    if (!facts.referer) {
      if (!zone.allowEmptyReferrer) return { outcome: 'block', reason: 'requests without a Referer are not allowed (hotlink protection)' };
    } else {
      let refHost = '';
      try {
        refHost = new URL(facts.referer).hostname.toLowerCase();
      } catch {
        return { outcome: 'block', reason: 'malformed Referer (hotlink protection)' };
      }
      const own = refHost === panelHost || zone.domains.some((d) => d.hostname === refHost);
      if (!own && !zone.allowedReferrers.some((p) => hostMatches(p, refHost))) return { outcome: 'block', reason: `referrer ${refHost} is not allowed (hotlink protection)` };
    }
  }
  return { outcome: 'allow', reason: 'zone checks passed' };
}

export async function evaluateRules(rules: SecurityRule[], facts: RequestFacts, opts: { dryRun?: boolean } = {}): Promise<EdgeDecision & { action?: SecurityRule['action']; rule?: SecurityRule }> {
  for (const rule of rules) {
    const conditions = parseConditions(rule.conditions);
    if (conditions.length === 0) continue;
    if (conditions.some((c) => c.field === 'requests_per_minute') && facts.requests_per_minute === undefined) {
      facts.requests_per_minute = opts.dryRun ? 0 : await requestsPerMinute(facts.ip);
    }
    if (!conditions.every((c) => conditionMatches(c, facts))) continue;
    if (!opts.dryRun) recordHit(rule.id);
    switch (rule.action) {
      case 'LOG':
        continue;
      case 'ALLOW':
        return { outcome: 'allow', reason: `allowed by rule "${rule.name}"`, ruleId: rule.id, action: rule.action, rule };
      case 'BLOCK':
        return { outcome: 'block', reason: `blocked by rule "${rule.name}"`, ruleId: rule.id, action: rule.action, rule };
      case 'CHALLENGE':
        return { outcome: 'challenge', reason: `challenge required by rule "${rule.name}"`, ruleId: rule.id, action: rule.action, rule };
      case 'BAN':
        return { outcome: 'block', reason: `banned by rule "${rule.name}"`, ruleId: rule.id, action: rule.action, rule };
    }
  }
  return { outcome: 'allow', reason: 'no rule matched' };
}

/**
 * Enforces zone restrictions and security rules for a delivery request. Throws `access_denied`
 * or sends the challenge page (returning true when the response was sent).
 */
export async function enforceEdgeSecurity(req: FastifyRequest, reply: FastifyReply, zone: ZoneWithRelations | null): Promise<boolean> {
  const facts = factsFor(req);
  const panelHost = normalizeHost(new URL(env().APP_URL).host);
  const zoneCheck = zoneAccessCheck(zone, facts, panelHost);
  if (zoneCheck.outcome === 'block') {
    void securityEvent('EDGE_BLOCKED', { ip: facts.ip, severity: 'info', details: { zone_id: zone?.id, reason: zoneCheck.reason, path: facts.path } });
    throw new AppError('access_denied');
  }
  const reg = await getZones();
  const rules = [...(zone?.securityRules ?? []), ...reg.globalRules];
  if (rules.length === 0) return false;
  const decision = await evaluateRules(rules, facts);
  if (decision.outcome === 'allow') return false;
  if (decision.outcome === 'challenge') {
    if (challengePassed(req)) return false;
    sendChallengePage(req, reply);
    return true;
  }
  if (decision.action === 'BAN' && decision.rule) {
    const already = await getRedis().exists(`ban:${facts.ip}`);
    if (!already) await banIp(facts.ip, decision.rule.banMinutes ?? 60, `Security rule: ${decision.rule.name}`, 'rule').catch((err) => baseLogger.error({ err }, 'ban failed'));
  }
  void securityEvent('EDGE_BLOCKED', { ip: facts.ip, severity: 'warning', details: { zone_id: zone?.id, rule_id: decision.ruleId, reason: decision.reason, path: facts.path } });
  throw new AppError('access_denied');
}
