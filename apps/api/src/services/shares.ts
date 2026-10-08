import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma, type File, type ShareLink } from '@cdn/database';
import { AppError, formatBytes, hmacSha256, newId, safeEqual, sha256Hex } from '@cdn/shared';
import { env, getKeyring } from '../config/env.js';
import { securityEvent } from '../lib/audit.js';
import { ipMatchesAny } from '../lib/ip.js';
import { anonymizeIp } from '../lib/ip.js';
import { getSettings } from '../lib/settings.js';

export type ShareWithFile = ShareLink & { file: File };

export async function findShareByToken(token: string): Promise<ShareWithFile> {
  if (!/^[0-9A-Za-z]{16,64}$/.test(token)) throw new AppError('share_not_found');
  const share = await getPrisma().shareLink.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { file: true } });
  if (!share || share.revokedAt || share.file.deletedAt || share.file.status !== 'READY') throw new AppError('share_not_found');
  return share;
}

export function shareState(share: ShareLink): 'active' | 'expired' | 'exhausted' | 'revoked' {
  if (share.revokedAt) return 'revoked';
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return 'expired';
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return 'exhausted';
  return 'active';
}

/** IP / country / expiry / download-count checks (password and email are handled by unlocking). */
export function assertShareAccess(req: FastifyRequest, share: ShareLink): void {
  const state = shareState(share);
  if (state === 'expired' || state === 'exhausted') throw new AppError('share_expired', state === 'exhausted' ? 'This share link has reached its download limit.' : undefined);
  if (state === 'revoked') throw new AppError('share_not_found');
  if (share.allowedIps.length && !ipMatchesAny(req.clientIp, share.allowedIps)) {
    void securityEvent('SHARE_DENIED', { ip: req.clientIp, severity: 'info', details: { share_id: share.id, reason: 'ip' } });
    throw new AppError('access_denied', 'This share link is not available from your network.');
  }
  if (share.allowedCountries.length && (!req.country || !share.allowedCountries.includes(req.country))) {
    void securityEvent('SHARE_DENIED', { ip: req.clientIp, severity: 'info', details: { share_id: share.id, reason: 'country', country: req.country } });
    throw new AppError('access_denied', 'This share link is not available in your country.');
  }
}

// ─── Unlock cookie (after password / email) ─────────────────────────────────

const UNLOCK_TTL = 30 * 60;

function unlockCookieName(share: ShareLink): string {
  return `cdn_share_${share.id.slice(-12).toLowerCase()}`;
}

function unlockMac(share: ShareLink, exp: number): string {
  return hmacSha256(getKeyring().subkey('signed-cookie'), `share\n${share.id}\n${share.tokenHash}\n${exp}`).toString('base64url');
}

export function needsUnlock(share: ShareLink): boolean {
  return Boolean(share.passwordHash) || share.requireEmail;
}

export function isUnlocked(req: FastifyRequest, share: ShareLink): boolean {
  if (!needsUnlock(share)) return true;
  const raw = req.cookies?.[unlockCookieName(share)];
  if (!raw) return false;
  const [expRaw, mac] = raw.split('.');
  const exp = Number(expRaw);
  return Boolean(mac) && exp > Date.now() / 1000 && safeEqual(mac!, unlockMac(share, exp));
}

export function setUnlocked(reply: FastifyReply, share: ShareLink): void {
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL;
  reply.setCookie(unlockCookieName(share), `${exp}.${unlockMac(share, exp)}`, { httpOnly: true, secure: env().cookieSecure, sameSite: 'lax', path: '/s/', maxAge: UNLOCK_TTL });
}

export async function recordShareAccess(req: FastifyRequest, share: ShareLink, data: { email?: string | null; downloaded: boolean }): Promise<void> {
  const settings = await getSettings();
  const ip = settings.analytics.ipStorage === 'none' ? null : settings.analytics.ipStorage === 'full' ? req.clientIp : anonymizeIp(req.clientIp);
  await getPrisma().shareAccess.create({
    data: { id: newId('shareAccess'), shareLinkId: share.id, email: data.email ?? null, ip, country: req.country, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null, downloaded: data.downloaded },
  });
  await getPrisma().shareLink.update({ where: { id: share.id }, data: { lastAccessedAt: new Date() } });
}

/**
 * Atomically consumes one download. Fails when the limit was reached concurrently.
 * One-time links are revoked as part of the same update.
 */
export async function consumeDownload(share: ShareLink): Promise<boolean> {
  const prisma = getPrisma();
  if (share.maxDownloads === null && !share.oneTime) {
    await prisma.shareLink.update({ where: { id: share.id }, data: { downloadCount: { increment: 1 } } });
    return true;
  }
  const limit = share.oneTime ? 1 : share.maxDownloads!;
  const updated = await prisma.$executeRaw`
    UPDATE "ShareLink" SET "downloadCount" = "downloadCount" + 1,
      "revokedAt" = CASE WHEN ${share.oneTime} THEN now() AT TIME ZONE 'UTC' ELSE "revokedAt" END,
      "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = ${share.id} AND "revokedAt" IS NULL AND "downloadCount" < ${limit}`;
  return updated === 1;
}

// ─── Landing page ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderSharePage(opts: {
  siteName: string;
  share: ShareWithFile;
  token: string;
  unlocked: boolean;
  error?: string;
  status?: number;
}): string {
  const { share, token, unlocked } = opts;
  const f = share.file;
  const remaining = share.oneTime ? 1 : share.maxDownloads !== null ? Math.max(0, share.maxDownloads - share.downloadCount) : null;
  const meta = [
    `${esc(f.mimeType)}`,
    formatBytes(Number(f.size)),
    share.expiresAt ? `Expires ${esc(share.expiresAt.toUTCString())}` : null,
    remaining !== null ? `${remaining} download${remaining === 1 ? '' : 's'} left` : null,
    share.oneTime ? 'Single use' : null,
  ].filter(Boolean);
  const form = !unlocked
    ? `<form method="post" action="/s/${esc(token)}/unlock" class="card">
        ${share.requireEmail ? '<label>Your email<input type="email" name="email" required autocomplete="email" maxlength="254"></label>' : ''}
        ${share.passwordHash ? '<label>Password<input type="password" name="password" required autocomplete="current-password" maxlength="256"></label>' : ''}
        <button type="submit">Continue</button>
      </form>`
    : `<a class="button" href="/s/${esc(token)}/download" rel="nofollow">Download</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(share.title ?? f.name)} · ${esc(opts.siteName)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#111827;--muted:#6b7280;--card:#fff;--line:#e5e7eb;--accent:#4f46e5;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--fg:#f3f4f6;--muted:#9ca3af;--card:#151821;--line:#262b36;--accent:#818cf8;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{width:100%;max-width:440px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:12px}
h1{font-size:20px;margin:0 0 4px;word-break:break-word}p{margin:0;color:var(--muted)}.meta{font-size:13px;color:var(--muted);margin-top:8px}
.msg{white-space:pre-wrap;color:var(--fg);margin-top:12px}label{display:block;font-size:13px;font-weight:600;margin-bottom:12px}
input{display:block;width:100%;margin-top:6px;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
button,.button{display:block;width:100%;text-align:center;padding:10px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:600 15px system-ui;text-decoration:none;cursor:pointer;margin-top:12px}
.err{color:var(--err);font-size:14px;margin-top:12px}.brand{font-size:12px;color:var(--muted);text-align:center;margin-top:16px}
</style></head><body><main>
<div class="card"><h1>${esc(share.title ?? f.name)}</h1>${share.title ? `<p>${esc(f.name)}</p>` : ''}<div class="meta">${meta.join(' · ')}</div>
${share.message ? `<div class="msg">${esc(share.message)}</div>` : ''}
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ''}
${unlocked ? form : ''}</div>
${unlocked ? '' : form}
<div class="brand">Shared securely via ${esc(opts.siteName)}</div>
</main></body></html>`;
}

export function sendHtml(reply: FastifyReply, html: string, status = 200): FastifyReply {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .send(html);
}
