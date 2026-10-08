import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { AppError, randomToken, sha256Hex, isValidId } from '@cdn/shared';
import { defineRoute, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { csrfTokenFor } from '../http/csrf.js';
import { getRateLimiter } from '../http/rateLimitHook.js';
import { audit, securityEvent } from '../lib/audit.js';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import { getRedis } from '../lib/redis.js';
import { clearSessionCookie, createSession, loadSession, revokeUserSessions } from '../lib/sessions.js';
import { getSettings } from '../lib/settings.js';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  storeRecoveryCodes,
  totpSetup,
  useRecoveryCode,
  verifyTotp,
} from '../lib/totp.js';

const email = z.string().trim().toLowerCase().email().max(254);

function session(auth: unknown): SessionAuth {
  return auth as SessionAuth;
}

async function sessionPayload(auth: SessionAuth) {
  const settings = await getSettings();
  return {
    user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, two_factor_enabled: auth.user.totpEnabled },
    roles: auth.roleNames,
    permissions: [...auth.permissions].sort(),
    csrf_token: csrfTokenFor(auth.token),
    session_id: auth.session.id,
    two_factor_enrollment_required: !auth.user.totpEnabled && (auth.user.requireTwoFactor || settings.security.requireTwoFactorForAll),
    site_name: settings.general.siteName,
  };
}

/** Brute-force protection: per-IP and per-account throttles plus temporary account lockout. */
async function checkLoginThrottle(ip: string, emailAddr: string) {
  const settings = await getSettings();
  const rl = getRateLimiter();
  const [byIp, byEmail] = await Promise.all([
    rl.hit(`login-ip:${ip}`, settings.rateLimits.loginPerIpPer15Min, 900),
    rl.hit(`login-email:${sha256Hex(emailAddr)}`, settings.rateLimits.loginPerEmailPer15Min, 900),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    void securityEvent('RATE_LIMITED', { ip, severity: 'warning', details: { bucket: 'login' } });
    throw new AppError('rate_limited', 'Too many sign-in attempts. Please wait before trying again.');
  }
  const locked = await getRedis().get(`lockout:${sha256Hex(emailAddr)}`);
  if (locked) throw new AppError('rate_limited', 'This account is temporarily locked after repeated failed sign-ins.');
}

async function recordLoginFailure(ip: string, emailAddr: string, userId: string | null, ua: string | null, reason: string) {
  const settings = await getSettings();
  const redis = getRedis();
  const key = `login-fail:${sha256Hex(emailAddr)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, settings.security.lockoutMinutes * 60);
  void securityEvent('LOGIN_FAILED', { ip, userId, userAgent: ua, details: { email: emailAddr, reason } });
  await audit({ actorId: userId, actorType: 'user', actorLabel: emailAddr, ip, userAgent: ua }, 'LOGIN_FAILED', userId ? { type: 'user', id: userId } : null, { reason });
  if (count >= settings.security.lockoutThreshold) {
    await redis.set(`lockout:${sha256Hex(emailAddr)}`, '1', 'EX', settings.security.lockoutMinutes * 60);
    await redis.del(key);
    void securityEvent('ACCOUNT_LOCKED', { ip, userId, severity: 'critical', details: { email: emailAddr, minutes: settings.security.lockoutMinutes } });
  }
}

/** Starts the second step of a sign-in for accounts with TOTP enabled. */
export async function issueMfaToken(userId: string, rememberMe: boolean): Promise<string> {
  const mfaToken = randomToken(32);
  await getRedis().set(`mfa:${sha256Hex(mfaToken)}`, JSON.stringify({ userId, rememberMe, attempts: 0 }), 'EX', 300);
  return mfaToken;
}

const sessionExample = {
  user: { id: 'usr_01J9Z8Q4X5K3W2V1T0S9R8Q7P6', email: 'admin@example.com', name: 'Ada Admin', two_factor_enabled: true },
  roles: ['Administrator'],
  permissions: ['files.view', 'files.upload'],
  csrf_token: 'k2l8...',
  session_id: 'ses_01J9Z8Q4X5K3W2V1T0S9R8Q7P6',
  two_factor_enrollment_required: false,
  site_name: 'CDN',
};

export const authRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/login',
    tag: 'Authentication',
    summary: 'Sign in (staff)',
    description:
      'Authenticates a staff member with email and password and sets an HttpOnly session cookie. If the account has two-factor authentication enabled the response contains `mfa_required: true` and a short-lived `mfa_token` to complete with `POST /api/v1/auth/login/mfa`.',
    auth: 'public',
    skipCsrf: true,
    body: z.object({ email, password: z.string().min(1).max(256), remember_me: z.boolean().default(false) }),
    responses: { 200: { description: 'Signed in, or MFA required', example: sessionExample } },
    errors: ['invalid_credentials', 'rate_limited', 'validation_failed'],
    async handler({ req, reply, body }) {
      await checkLoginThrottle(req.clientIp, body.email);
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      const ok = await verifyPassword(user?.passwordHash, body.password);
      const ua = req.headers['user-agent'] ?? null;
      if (!user || !ok) {
        await recordLoginFailure(req.clientIp, body.email, user?.id ?? null, ua, user ? 'bad_password' : 'unknown_user');
        throw new AppError('invalid_credentials');
      }
      if (user.status !== 'ACTIVE') {
        await recordLoginFailure(req.clientIp, body.email, user.id, ua, 'disabled');
        throw new AppError('invalid_credentials');
      }
      await getRedis().del(`login-fail:${sha256Hex(body.email)}`);
      if (needsRehash(user.passwordHash!)) {
        await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password) } });
      }
      const settings = await getSettings();
      if (!settings.security.passwordLoginEnabled) {
        // Users who have not set up a passkey or SSO identity yet may still use their password, so nobody is locked out.
        const [passkeys, identities] = await Promise.all([prisma.webAuthnCredential.count({ where: { userId: user.id } }), prisma.userIdentity.count({ where: { userId: user.id } })]);
        if (passkeys + identities > 0) throw new AppError('forbidden', 'Password sign-in is disabled. Sign in with a passkey or single sign-on.');
      }
      if (user.totpEnabled && user.totpSecretEnc) {
        return { mfa_required: true, mfa_token: await issueMfaToken(user.id, body.remember_me) };
      }
      return completeLogin(req, reply, user.id, body.remember_me);
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/login/mfa',
    tag: 'Authentication',
    summary: 'Complete sign-in with a 2FA code',
    description: 'Completes a sign-in that returned `mfa_required`. Accepts a 6-digit TOTP code or a single-use recovery code.',
    auth: 'public',
    skipCsrf: true,
    body: z.object({ mfa_token: z.string().min(10).max(100), code: z.string().min(6).max(20) }),
    responses: { 200: { description: 'Signed in', example: sessionExample } },
    errors: ['invalid_mfa_code', 'session_expired', 'rate_limited'],
    async handler({ req, reply, body }) {
      const redis = getRedis();
      const key = `mfa:${sha256Hex(body.mfa_token)}`;
      const raw = await redis.get(key);
      if (!raw) throw new AppError('session_expired', 'The sign-in attempt has expired. Please sign in again.');
      const pending = JSON.parse(raw) as { userId: string; rememberMe: boolean; attempts: number };
      const user = await getPrisma().user.findUnique({ where: { id: pending.userId } });
      if (!user || user.status !== 'ACTIVE' || !user.totpSecretEnc) throw new AppError('session_expired');
      const code = body.code.trim();
      const valid = /^\d{6}$/.test(code)
        ? await verifyTotp(user.id, decryptTotpSecret(user.id, user.totpSecretEnc), code)
        : await useRecoveryCode(user.id, code);
      if (!valid) {
        pending.attempts++;
        if (pending.attempts >= 5) await redis.del(key);
        else await redis.set(key, JSON.stringify(pending), 'KEEPTTL');
        void securityEvent('MFA_FAILED', { ip: req.clientIp, userId: user.id, userAgent: req.headers['user-agent'] ?? null });
        await recordLoginFailure(req.clientIp, user.email, user.id, req.headers['user-agent'] ?? null, 'bad_mfa_code');
        throw new AppError('invalid_mfa_code');
      }
      await redis.del(key);
      return completeLogin(req, reply, user.id, pending.rememberMe);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/session',
    tag: 'Authentication',
    summary: 'Current staff session',
    description: 'Returns the signed-in staff member, their effective permissions and the CSRF token required for state-changing requests.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    responses: { 200: { description: 'Session details', example: sessionExample } },
    errors: ['unauthenticated'],
    async handler({ auth }) {
      return sessionPayload(session(auth));
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/logout',
    tag: 'Authentication',
    summary: 'Sign out',
    description: 'Revokes the current session and clears the session cookie.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    responses: { 204: { description: 'Signed out' } },
    async handler({ req, reply, auth }) {
      const s = session(auth);
      await getPrisma().session.update({ where: { id: s.session.id }, data: { revokedAt: new Date() } });
      clearSessionCookie(reply);
      await audit(actorOf(req), 'LOGOUT', { type: 'session', id: s.session.id });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/logout-all',
    tag: 'Authentication',
    summary: 'Sign out of all devices',
    description: 'Revokes every session of the current user, including this one.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    responses: { 200: { description: 'Sessions revoked', example: { revoked: 3 } } },
    async handler({ req, reply, auth }) {
      const s = session(auth);
      const revoked = await revokeUserSessions(s.user.id);
      clearSessionCookie(reply);
      await audit(actorOf(req), 'LOGOUT_ALL', { type: 'user', id: s.user.id }, { revoked });
      return { revoked };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    tag: 'Authentication',
    summary: 'List my sessions',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    responses: { 200: { description: 'Active sessions' } },
    async handler({ auth }) {
      const s = session(auth);
      const rows = await getPrisma().session.findMany({
        where: { userId: s.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: 'desc' },
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          ip: r.ip,
          user_agent: r.userAgent,
          remember_me: r.rememberMe,
          current: r.id === s.session.id,
          last_seen_at: r.lastSeenAt.toISOString(),
          expires_at: r.expiresAt.toISOString(),
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/auth/sessions/:id',
    tag: 'Authentication',
    summary: 'Sign out a specific session',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    params: z.object({ id: z.string().refine((v) => isValidId('session', v), 'invalid session id') }),
    responses: { 204: { description: 'Session revoked' } },
    errors: ['not_found'],
    async handler({ req, reply, params, auth }) {
      const s = session(auth);
      const res = await getPrisma().session.updateMany({ where: { id: params.id, userId: s.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (res.count === 0) throw new AppError('not_found');
      if (params.id === s.session.id) clearSessionCookie(reply);
      await audit(actorOf(req), 'SESSION_REVOKED', { type: 'session', id: params.id });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/reauth',
    tag: 'Authentication',
    summary: 'Confirm password (step-up authentication)',
    description:
      'Re-verifies the current password (and 2FA code when enabled). Sensitive actions such as deleting users, revoking all API keys or changing storage require a re-authentication within the configured window.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    rateLimit: { name: 'reauth', max: 10, windowSeconds: 900 },
    body: z.object({ password: z.string().min(1).max(256), code: z.string().max(20).optional() }),
    responses: { 200: { description: 'Re-authenticated', example: { reauthenticated_until: '2026-01-01T12:10:00.000Z' } } },
    errors: ['invalid_credentials', 'invalid_mfa_code', 'rate_limited'],
    async handler({ req, body, auth }) {
      const s = session(auth);
      const prisma = getPrisma();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
      if (!(await verifyPassword(user.passwordHash, body.password))) {
        void securityEvent('LOGIN_FAILED', { ip: req.clientIp, userId: user.id, details: { reason: 'reauth_bad_password' } });
        throw new AppError('invalid_credentials', 'The password is incorrect.');
      }
      if (user.totpEnabled && user.totpSecretEnc) {
        if (!body.code || !(await verifyTotp(user.id, decryptTotpSecret(user.id, user.totpSecretEnc), body.code))) {
          throw new AppError('invalid_mfa_code');
        }
      }
      const now = new Date();
      await prisma.session.update({ where: { id: s.session.id }, data: { reauthAt: now } });
      const settings = await getSettings();
      return { reauthenticated_until: new Date(now.getTime() + settings.security.reauthWindowMinutes * 60_000).toISOString() };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/password',
    tag: 'Authentication',
    summary: 'Change my password',
    description: 'Changes the password and revokes all other sessions.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    rateLimit: { name: 'password-change', max: 10, windowSeconds: 900 },
    body: z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) }),
    responses: { 204: { description: 'Password changed' } },
    errors: ['invalid_credentials', 'validation_failed'],
    async handler({ req, body, auth }) {
      const s = session(auth);
      const prisma = getPrisma();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
      if (!(await verifyPassword(user.passwordHash, body.current_password))) throw new AppError('invalid_credentials', 'The current password is incorrect.');
      const policy = checkPasswordPolicy(body.new_password, { email: user.email });
      if (!policy.ok) throw new AppError('validation_failed', policy.message);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.new_password), passwordChangedAt: new Date() } });
      await revokeUserSessions(user.id, s.session.id);
      await audit(actorOf(req), 'PASSWORD_CHANGED', { type: 'user', id: user.id });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/2fa/setup',
    tag: 'Authentication',
    summary: 'Begin TOTP 2FA enrollment',
    description: 'Generates a new TOTP secret (stored encrypted, not yet active) and returns it with a QR code.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    responses: { 200: { description: 'Enrollment data', example: { secret: 'JBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/...', qr_data_url: 'data:image/png;base64,...' } } },
    errors: ['conflict'],
    async handler({ auth }) {
      const s = session(auth);
      if (s.user.totpEnabled) throw new AppError('conflict', 'Two-factor authentication is already enabled.');
      const settings = await getSettings();
      const setup = await totpSetup(s.user.id, s.user.email, settings.general.siteName);
      await getPrisma().user.update({ where: { id: s.user.id }, data: { totpSecretEnc: encryptTotpSecret(s.user.id, setup.secret), totpEnabled: false } });
      return { secret: setup.secret, otpauth_url: setup.otpauthUrl, qr_data_url: setup.qrDataUrl };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/2fa/enable',
    tag: 'Authentication',
    summary: 'Confirm TOTP 2FA enrollment',
    description: 'Verifies a code from the authenticator app, enables 2FA and returns single-use recovery codes. Recovery codes are shown only once.',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    body: z.object({ code: z.string().regex(/^\d{6}$/) }),
    responses: { 200: { description: 'Enabled', example: { recovery_codes: ['ABCDE-12345'] } } },
    errors: ['invalid_mfa_code', 'conflict'],
    async handler({ req, body, auth }) {
      const s = session(auth);
      const prisma = getPrisma();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
      if (user.totpEnabled) throw new AppError('conflict', 'Two-factor authentication is already enabled.');
      if (!user.totpSecretEnc) throw new AppError('conflict', 'Start enrollment first.');
      if (!(await verifyTotp(user.id, decryptTotpSecret(user.id, user.totpSecretEnc), body.code))) throw new AppError('invalid_mfa_code');
      const codes = generateRecoveryCodes();
      await storeRecoveryCodes(user.id, codes);
      await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
      await audit(actorOf(req), 'TWO_FACTOR_ENABLED', { type: 'user', id: user.id });
      return { recovery_codes: codes };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/2fa/disable',
    tag: 'Authentication',
    summary: 'Disable TOTP 2FA',
    description: 'Requires a recent password re-authentication. Not allowed when 2FA is mandatory for the account.',
    auth: 'session',
    requireReauth: true,
    responses: { 204: { description: 'Disabled' } },
    errors: ['reauthentication_required', 'forbidden'],
    async handler({ req, auth }) {
      const s = session(auth);
      const settings = await getSettings();
      if (s.user.requireTwoFactor || settings.security.requireTwoFactorForAll) {
        throw new AppError('forbidden', 'Two-factor authentication is required for your account.');
      }
      const prisma = getPrisma();
      await prisma.$transaction([
        prisma.user.update({ where: { id: s.user.id }, data: { totpEnabled: false, totpSecretEnc: null } }),
        prisma.recoveryCode.deleteMany({ where: { userId: s.user.id } }),
      ]);
      await audit(actorOf(req), 'TWO_FACTOR_DISABLED', { type: 'user', id: s.user.id });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/2fa/recovery-codes',
    tag: 'Authentication',
    summary: 'Regenerate recovery codes',
    description: 'Invalidates all previous recovery codes. Requires a recent re-authentication.',
    auth: 'session',
    requireReauth: true,
    responses: { 200: { description: 'New codes', example: { recovery_codes: ['ABCDE-12345'] } } },
    errors: ['reauthentication_required', 'conflict'],
    async handler({ req, auth }) {
      const s = session(auth);
      if (!s.user.totpEnabled) throw new AppError('conflict', 'Two-factor authentication is not enabled.');
      const codes = generateRecoveryCodes();
      await storeRecoveryCodes(s.user.id, codes);
      await audit(actorOf(req), 'RECOVERY_CODES_REGENERATED', { type: 'user', id: s.user.id });
      return { recovery_codes: codes };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/token/:token',
    tag: 'Authentication',
    summary: 'Inspect an invitation or password-reset token',
    auth: 'public',
    rateLimit: { name: 'token-inspect', max: 30, windowSeconds: 900 },
    params: z.object({ token: z.string().min(20).max(100) }),
    responses: { 200: { description: 'Token details', example: { type: 'INVITE', email: 'new@example.com', name: 'New Staff' } } },
    errors: ['not_found'],
    async handler({ params }) {
      const t = await getPrisma().userToken.findUnique({ where: { tokenHash: sha256Hex(params.token) }, include: { user: true } });
      if (!t || t.usedAt || t.expiresAt.getTime() < Date.now()) throw new AppError('not_found', 'This link is invalid or has expired.');
      return { type: t.type, email: t.user.email, name: t.user.name };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/token/accept',
    tag: 'Authentication',
    summary: 'Accept an invitation / reset a password',
    description: 'Sets the password for an invited user or a password reset, activates the account and revokes existing sessions.',
    auth: 'public',
    skipCsrf: true,
    rateLimit: { name: 'token-accept', max: 10, windowSeconds: 900 },
    body: z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(256) }),
    responses: { 204: { description: 'Password set' } },
    errors: ['not_found', 'validation_failed'],
    async handler({ req, body }) {
      const prisma = getPrisma();
      const t = await prisma.userToken.findUnique({ where: { tokenHash: sha256Hex(body.token) }, include: { user: true } });
      if (!t || t.usedAt || t.expiresAt.getTime() < Date.now()) throw new AppError('not_found', 'This link is invalid or has expired.');
      if (t.user.status === 'DISABLED') throw new AppError('account_disabled');
      const policy = checkPasswordPolicy(body.password, { email: t.user.email, name: t.user.name });
      if (!policy.ok) throw new AppError('validation_failed', policy.message);
      const claimed = await prisma.userToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new AppError('not_found', 'This link is invalid or has expired.');
      await prisma.user.update({
        where: { id: t.userId },
        data: { passwordHash: await hashPassword(body.password), status: 'ACTIVE', passwordChangedAt: new Date() },
      });
      await revokeUserSessions(t.userId);
      await audit(
        { actorId: t.userId, actorType: 'user', actorLabel: t.user.email, ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null },
        t.type === 'INVITE' ? 'INVITE_ACCEPTED' : 'PASSWORD_CHANGED',
        { type: 'user', id: t.userId },
      );
    },
  }),
];

export async function completeLogin(req: Parameters<typeof createSession>[1], reply: Parameters<typeof createSession>[0], userId: string, rememberMe: boolean) {
  const prisma = getPrisma();
  const { token, id } = await createSession(reply, req, userId, rememberMe);
  const user = await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), lastLoginIp: req.clientIp } });
  await audit({ actorId: user.id, actorType: 'user', actorLabel: user.email, ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null }, 'LOGIN_SUCCESS', {
    type: 'session',
    id,
  });
  const auth = await loadSession(token);
  if (!auth) throw new AppError('internal_error');
  return sessionPayload(auth);
}
