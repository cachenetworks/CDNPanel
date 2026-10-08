import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getPrisma, type SsoProvider } from '@cdn/database';
import { AppError, decryptField, encryptField, isValidId, newId, randomToken, sha256Hex, slugifySegment } from '@cdn/shared';
import { defineRoute, enforceReauth, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { env, getKeyring } from '../config/env.js';
import { audit, securityEvent } from '../lib/audit.js';
import { getRedis } from '../lib/redis.js';
import { getSettings } from '../lib/settings.js';
import { createSession } from '../lib/sessions.js';
import { completeLogin, issueMfaToken } from './auth.js';

// ─── Passkeys (WebAuthn) ────────────────────────────────────────────────────

function rp() {
  const url = new URL(env().APP_URL);
  return { rpID: url.hostname, origin: url.origin };
}

const responseJson = z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.record(z.unknown()), clientExtensionResults: z.record(z.unknown()).default({}), authenticatorAttachment: z.string().optional() }).passthrough();

function serializePasskey(p: { id: string; name: string; deviceType: string | null; backedUp: boolean; transports: string[]; lastUsedAt: Date | null; createdAt: Date }) {
  return { id: p.id, name: p.name, device_type: p.deviceType, backed_up: p.backedUp, transports: p.transports, last_used_at: p.lastUsedAt?.toISOString() ?? null, created_at: p.createdAt.toISOString() };
}

// ─── SSO helpers ────────────────────────────────────────────────────────────

export function ssoSecretAad(id: string): string {
  return `sso_client_secret:${id}`;
}

interface Endpoints {
  authorize: string;
  token: string;
  userinfo: string;
  scopes: string[];
}

const discoveryCache = new Map<string, { at: number; value: Endpoints }>();

async function endpointsFor(p: SsoProvider): Promise<Endpoints> {
  switch (p.kind) {
    case 'GITHUB':
      return { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user', scopes: ['read:user', 'user:email'] };
    case 'DISCORD':
      return { authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token', userinfo: 'https://discord.com/api/users/@me', scopes: ['identify', 'email'] };
    case 'GOOGLE':
    case 'OIDC': {
      const issuer = (p.kind === 'GOOGLE' ? 'https://accounts.google.com' : p.issuer ?? '').replace(/\/+$/, '');
      if (!issuer) throw new AppError('sso_failed', 'The OIDC provider has no issuer configured.');
      const hit = discoveryCache.get(issuer);
      if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new AppError('sso_failed', 'OIDC discovery failed.');
      const doc = (await res.json()) as { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; issuer: string };
      if (doc.issuer.replace(/\/+$/, '') !== issuer) throw new AppError('sso_failed', 'OIDC issuer mismatch.');
      const value = { authorize: doc.authorization_endpoint, token: doc.token_endpoint, userinfo: doc.userinfo_endpoint, scopes: ['openid', 'email', 'profile'] };
      discoveryCache.set(issuer, { at: Date.now(), value });
      return value;
    }
  }
}

function redirectUri(p: SsoProvider): string {
  return `${env().APP_URL}/api/v1/auth/sso/${p.slug}/callback`;
}

interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

async function fetchProfile(p: SsoProvider, ep: Endpoints, accessToken: string): Promise<Profile> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'CDNPanel-SSO' };
  const res = await fetch(ep.userinfo, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError('sso_failed', 'Could not load the user profile from the identity provider.');
  const u = (await res.json()) as Record<string, unknown>;
  if (p.kind === 'GITHUB') {
    const emails = (await (await fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10_000) })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
    return { subject: String(u.id), email: primary?.email ?? null, emailVerified: Boolean(primary), name: (u.name as string) || (u.login as string) || null };
  }
  if (p.kind === 'DISCORD') {
    return { subject: String(u.id), email: (u.email as string) ?? null, emailVerified: u.verified === true, name: (u.global_name as string) || (u.username as string) || null };
  }
  return { subject: String(u.sub), email: (u.email as string) ?? null, emailVerified: u.email_verified === true || u.email_verified === 'true', name: (u.name as string) ?? null };
}

function serializeProvider(p: SsoProvider) {
  return {
    id: p.id,
    object: 'sso_provider' as const,
    name: p.name,
    slug: p.slug,
    kind: p.kind,
    client_id: p.clientId,
    issuer: p.issuer,
    scopes: p.scopes,
    enabled: p.enabled,
    auto_provision: p.autoProvision,
    default_role_id: p.defaultRoleId,
    allowed_domains: p.allowedDomains,
    redirect_uri: redirectUri(p),
    created_at: p.createdAt.toISOString(),
  };
}

function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function loginRedirect(reply: FastifyReply, params: Record<string, string>): FastifyReply {
  return reply.redirect(`${env().APP_URL}/login?${new URLSearchParams(params).toString()}`, 302);
}

const providerBody = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['OIDC', 'GOOGLE', 'GITHUB', 'DISCORD']),
  client_id: z.string().trim().min(1).max(300),
  client_secret: z.string().min(1).max(500),
  issuer: z.string().url().max(500).nullable().optional(),
  scopes: z.array(z.string().max(100)).max(20).optional(),
  enabled: z.boolean().default(true),
  auto_provision: z.boolean().default(false),
  default_role_id: z.string().nullable().optional(),
  allowed_domains: z.array(z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(50).default([]),
};

export const identityRoutes: RouteDef<any, any, any>[] = [
  // ─── Passkeys ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/passkeys',
    tag: 'Single Sign-On',
    summary: 'List my passkeys',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    async handler({ auth }) {
      const rows = await getPrisma().webAuthnCredential.findMany({ where: { userId: (auth as SessionAuth).user.id }, orderBy: { createdAt: 'asc' } });
      return { data: rows.map(serializePasskey) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/passkeys/register/options',
    tag: 'Single Sign-On',
    summary: 'Start passkey registration',
    auth: 'session',
    requireReauth: true,
    allowDuringMfaEnrollment: true,
    errors: ['reauthentication_required'],
    async handler({ auth }) {
      const a = auth as SessionAuth;
      const settings = await getSettings();
      const existing = await getPrisma().webAuthnCredential.findMany({ where: { userId: a.user.id } });
      const options = await generateRegistrationOptions({
        rpName: settings.general.siteName,
        rpID: rp().rpID,
        userName: a.user.email,
        userDisplayName: a.user.name,
        userID: new Uint8Array(createHash('sha256').update(a.user.id).digest()),
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      await getRedis().set(`wa-reg:${a.user.id}`, options.challenge, 'EX', 300);
      return options;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/passkeys/register/verify',
    tag: 'Single Sign-On',
    summary: 'Finish passkey registration',
    auth: 'session',
    allowDuringMfaEnrollment: true,
    body: z.object({ name: z.string().trim().min(1).max(60).default('Passkey'), response: responseJson }),
    errors: ['passkey_failed'],
    async handler({ req, body, auth }) {
      const a = auth as SessionAuth;
      const redis = getRedis();
      const challenge = await redis.get(`wa-reg:${a.user.id}`);
      await redis.del(`wa-reg:${a.user.id}`);
      if (!challenge) throw new AppError('passkey_failed', 'The registration has expired. Please try again.');
      const { rpID, origin } = rp();
      let verification;
      try {
        verification = await verifyRegistrationResponse({ response: body.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      } catch (err) {
        throw new AppError('passkey_failed', (err as Error).message);
      }
      if (!verification.verified || !verification.registrationInfo) throw new AppError('passkey_failed');
      const info = verification.registrationInfo;
      const created = await getPrisma().webAuthnCredential.create({
        data: {
          id: newId('passkey'),
          userId: a.user.id,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: BigInt(info.credential.counter),
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          name: body.name,
        },
      });
      await audit(actorOf(req), 'PASSKEY_REGISTERED', { type: 'user', id: a.user.id }, { passkey_id: created.id, name: body.name });
      return serializePasskey(created);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/auth/passkeys/:id',
    tag: 'Single Sign-On',
    summary: 'Delete a passkey',
    auth: 'session',
    requireReauth: true,
    params: z.object({ id: z.string() }),
    errors: ['not_found', 'reauthentication_required'],
    async handler({ req, params, auth }) {
      const a = auth as SessionAuth;
      const pk = await getPrisma().webAuthnCredential.findFirst({ where: { id: params.id, userId: a.user.id } });
      if (!pk) throw new AppError('not_found');
      await getPrisma().webAuthnCredential.delete({ where: { id: pk.id } });
      await audit(actorOf(req), 'PASSKEY_DELETED', { type: 'user', id: a.user.id }, { passkey_id: pk.id, name: pk.name });
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/passkeys/login/options',
    tag: 'Single Sign-On',
    summary: 'Start passkey sign-in',
    description: 'Returns WebAuthn request options for a usernameless (discoverable credential) sign-in.',
    auth: 'public',
    skipCsrf: true,
    rateLimit: { name: 'passkey-login', max: 30, windowSeconds: 300 },
    async handler() {
      const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: 'required' });
      const flow = randomToken(24);
      await getRedis().set(`wa-auth:${sha256Hex(flow)}`, options.challenge, 'EX', 300);
      return { flow_id: flow, options };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/passkeys/login/verify',
    tag: 'Single Sign-On',
    summary: 'Finish passkey sign-in',
    description: 'Verifies the assertion and signs the user in. Passkeys require user verification, so they satisfy two-factor authentication on their own.',
    auth: 'public',
    skipCsrf: true,
    rateLimit: { name: 'passkey-login', max: 30, windowSeconds: 300 },
    body: z.object({ flow_id: z.string().min(10).max(100), response: responseJson, remember_me: z.boolean().default(false) }),
    errors: ['passkey_failed'],
    async handler({ req, reply, body }) {
      const redis = getRedis();
      const key = `wa-auth:${sha256Hex(body.flow_id)}`;
      const challenge = await redis.get(key);
      await redis.del(key);
      if (!challenge) throw new AppError('passkey_failed', 'The sign-in attempt has expired. Please try again.');
      const response = body.response as unknown as AuthenticationResponseJSON;
      const prisma = getPrisma();
      const cred = await prisma.webAuthnCredential.findUnique({ where: { credentialId: response.id }, include: { user: true } });
      const fail = async (reason: string) => {
        void securityEvent('PASSKEY_FAILED', { ip: req.clientIp, userId: cred?.userId ?? null, userAgent: req.headers['user-agent'] ?? null, details: { reason } });
        throw new AppError('passkey_failed');
      };
      if (!cred || cred.user.status !== 'ACTIVE') return fail('unknown_credential');
      const { rpID, origin } = rp();
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: { id: cred.credentialId, publicKey: new Uint8Array(cred.publicKey), counter: Number(cred.counter), transports: cred.transports as AuthenticatorTransportFuture[] },
          requireUserVerification: true,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
      if (!verification.verified) return fail('not_verified');
      await prisma.webAuthnCredential.update({ where: { id: cred.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() } });
      return completeLogin(req, reply, cred.userId, body.remember_me);
    },
  }),

  // ─── SSO: public ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/sso/providers',
    tag: 'Single Sign-On',
    summary: 'Enabled sign-in providers',
    description: 'Public list used by the sign-in page.',
    auth: 'public',
    async handler() {
      const rows = await getPrisma().ssoProvider.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
      const settings = await getSettings();
      return { password_login: settings.security.passwordLoginEnabled, providers: rows.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind, start_url: `/api/v1/auth/sso/${p.slug}/start` })) };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/sso/:slug/start',
    tag: 'Single Sign-On',
    summary: 'Start single sign-on',
    description: 'Redirects to the identity provider (authorization code flow with PKCE and state). With `link=1` and a staff session, the identity is linked to the signed-in account instead.',
    auth: 'public',
    params: z.object({ slug: z.string().max(80) }),
    query: z.object({ next: z.string().max(500).optional(), link: z.enum(['1']).optional(), remember_me: z.enum(['1']).optional() }),
    rateLimit: { name: 'sso-start', max: 30, windowSeconds: 300 },
    async handler({ req, reply, params, query }) {
      const p = await getPrisma().ssoProvider.findUnique({ where: { slug: params.slug } });
      if (!p || !p.enabled) throw new AppError('not_found');
      const ep = await endpointsFor(p);
      const state = randomToken(24);
      const verifier = randomToken(48);
      const nonce = randomToken(16);
      const linkUserId = query.link && req.auth?.type === 'session' ? req.auth.user.id : null;
      await getRedis().set(`sso:${sha256Hex(state)}`, JSON.stringify({ providerId: p.id, verifier, nonce, next: safeNext(query.next), linkUserId, rememberMe: Boolean(query.remember_me) }), 'EX', 600);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(ep.authorize);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: redirectUri(p),
        scope: (p.scopes.length ? p.scopes : ep.scopes).join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(p.kind === 'OIDC' || p.kind === 'GOOGLE' ? { nonce } : {}),
        ...(p.kind === 'DISCORD' ? { prompt: 'none' } : {}),
      }).toString();
      return reply.redirect(url.toString(), 302);
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/sso/:slug/callback',
    tag: 'Single Sign-On',
    summary: 'Single sign-on callback',
    auth: 'public',
    hidden: true,
    params: z.object({ slug: z.string().max(80) }),
    query: z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }),
    async handler({ req, reply, params, query }) {
      const redis = getRedis();
      const fail = (reason: string, userId: string | null = null) => {
        void securityEvent('SSO_FAILED', { ip: req.clientIp, userId, userAgent: req.headers['user-agent'] ?? null, details: { provider: params.slug, reason } });
        return loginRedirect(reply, { sso_error: reason });
      };
      if (query.error || !query.code || !query.state) return fail(query.error ?? 'missing_code');
      const raw = await redis.get(`sso:${sha256Hex(query.state)}`);
      await redis.del(`sso:${sha256Hex(query.state)}`);
      if (!raw) return fail('state_expired');
      const flow = JSON.parse(raw) as { providerId: string; verifier: string; next: string; linkUserId: string | null; rememberMe: boolean };
      const prisma = getPrisma();
      const p = await prisma.ssoProvider.findUnique({ where: { id: flow.providerId } });
      if (!p || p.slug !== params.slug || !p.enabled) return fail('provider_unavailable');
      const ep = await endpointsFor(p);
      const tokenRes = await fetch(ep.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: redirectUri(p),
          client_id: p.clientId,
          client_secret: decryptField(getKeyring(), p.clientSecretEnc, ssoSecretAad(p.id)),
          code_verifier: flow.verifier,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
      if (!tokenRes.ok || !tokens.access_token) return fail('token_exchange_failed');
      const profile = await fetchProfile(p, ep, tokens.access_token);
      if (!profile.subject) return fail('no_subject');
      const email = profile.email?.toLowerCase() ?? null;
      if (p.allowedDomains.length && (!email || !p.allowedDomains.includes(email.split('@')[1]!))) return fail('domain_not_allowed');

      const identity = await prisma.userIdentity.findUnique({ where: { providerId_subject: { providerId: p.id, subject: profile.subject } }, include: { user: true } });
      // Linking from the account page.
      if (flow.linkUserId) {
        if (identity && identity.userId !== flow.linkUserId) return reply.redirect(`${env().APP_URL}/dashboard/account?sso_error=already_linked`, 302);
        if (!identity) {
          await prisma.userIdentity.create({ data: { id: newId('identity'), userId: flow.linkUserId, providerId: p.id, subject: profile.subject, email } });
          await audit({ actorId: flow.linkUserId, actorType: 'user', ip: req.clientIp }, 'SSO_LINKED', { type: 'user', id: flow.linkUserId }, { provider: p.slug, email });
        }
        return reply.redirect(`${env().APP_URL}/dashboard/account?sso_linked=${encodeURIComponent(p.name)}`, 302);
      }

      let userId = identity?.userId ?? null;
      if (!userId && email && profile.emailVerified) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          userId = user.id;
          await prisma.userIdentity.create({ data: { id: newId('identity'), userId: user.id, providerId: p.id, subject: profile.subject, email } });
          await audit({ actorId: user.id, actorType: 'user', actorLabel: email, ip: req.clientIp }, 'SSO_LINKED', { type: 'user', id: user.id }, { provider: p.slug, automatic: true });
        } else if (p.autoProvision && p.defaultRoleId) {
          const created = await prisma.user.create({
            data: { id: newId('user'), email, name: (profile.name ?? email.split('@')[0]!).slice(0, 100), passwordHash: null, status: 'ACTIVE', roles: { create: [{ roleId: p.defaultRoleId }] } },
          });
          await prisma.userIdentity.create({ data: { id: newId('identity'), userId: created.id, providerId: p.id, subject: profile.subject, email } });
          userId = created.id;
          await audit({ actorType: 'system', actorLabel: `sso:${p.slug}`, ip: req.clientIp }, 'SSO_USER_PROVISIONED', { type: 'user', id: created.id }, { email, role_id: p.defaultRoleId });
        }
      }
      if (!userId) return fail('no_matching_account');
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'ACTIVE') return fail('account_disabled', userId);
      await prisma.userIdentity.updateMany({ where: { providerId: p.id, subject: profile.subject }, data: { lastLoginAt: new Date(), email } });
      // Accounts with TOTP still complete the second factor in the dashboard.
      if (user.totpEnabled && user.totpSecretEnc) return loginRedirect(reply, { mfa_token: await issueMfaToken(user.id, flow.rememberMe), next: flow.next });
      const { id } = await createSession(reply, req, user.id, flow.rememberMe);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastLoginIp: req.clientIp } });
      await audit({ actorId: user.id, actorType: 'user', actorLabel: user.email, ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null }, 'LOGIN_SUCCESS', { type: 'session', id }, { method: `sso:${p.slug}` });
      return reply.redirect(`${env().APP_URL}${flow.next}`, 302);
    },
  }),

  // ─── SSO: my identities ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/identities',
    tag: 'Single Sign-On',
    summary: 'My linked identities',
    auth: 'session',
    async handler({ auth }) {
      const rows = await getPrisma().userIdentity.findMany({ where: { userId: (auth as SessionAuth).user.id }, include: { provider: true } });
      return { data: rows.map((i) => ({ id: i.id, provider: { slug: i.provider.slug, name: i.provider.name, kind: i.provider.kind }, email: i.email, last_login_at: i.lastLoginAt?.toISOString() ?? null, created_at: i.createdAt.toISOString() })) };
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/auth/identities/:id',
    tag: 'Single Sign-On',
    summary: 'Unlink an identity',
    auth: 'session',
    requireReauth: true,
    params: z.object({ id: z.string() }),
    errors: ['not_found', 'reauthentication_required'],
    async handler({ req, params, auth }) {
      const a = auth as SessionAuth;
      const identity = await getPrisma().userIdentity.findFirst({ where: { id: params.id, userId: a.user.id } });
      if (!identity) throw new AppError('not_found');
      await getPrisma().userIdentity.delete({ where: { id: identity.id } });
      await audit(actorOf(req), 'SSO_UNLINKED', { type: 'user', id: a.user.id }, { identity_id: identity.id });
    },
  }),

  // ─── SSO: provider administration ───
  defineRoute({
    method: 'GET',
    url: '/api/v1/sso/providers',
    tag: 'Single Sign-On',
    summary: 'List SSO providers',
    auth: 'session',
    permission: 'settings.view',
    async handler() {
      const rows = await getPrisma().ssoProvider.findMany({ orderBy: { name: 'asc' } });
      return { data: rows.map(serializeProvider) };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/sso/providers',
    tag: 'Single Sign-On',
    summary: 'Add an SSO provider',
    description:
      'Registers an OIDC, Google, GitHub or Discord OAuth application. Use the returned `redirect_uri` as the callback URL in the provider console. Existing staff are matched by verified email; with `auto_provision` new staff are created with `default_role_id`.',
    auth: 'session',
    permission: 'security.manage',
    requireReauth: true,
    body: z.object(providerBody),
    responses: { 201: { description: 'Provider' } },
    errors: ['validation_failed', 'conflict', 'reauthentication_required'],
    async handler({ req, reply, body }) {
      if (body.kind === 'OIDC' && !body.issuer) throw new AppError('validation_failed', 'OIDC providers need an issuer URL.');
      if (body.auto_provision && !body.default_role_id) throw new AppError('validation_failed', 'Auto-provisioning needs a default role.');
      if (body.default_role_id && !(await getPrisma().role.findUnique({ where: { id: body.default_role_id } }))) throw new AppError('role_not_found');
      const id = newId('ssoProvider');
      const slug = slugifySegment(body.name).replace(/\./g, '-').slice(0, 40) || 'sso';
      if (await getPrisma().ssoProvider.findFirst({ where: { OR: [{ slug }, { name: body.name }] } })) throw new AppError('conflict', 'A provider with that name already exists.');
      const p = await getPrisma().ssoProvider.create({
        data: {
          id,
          name: body.name,
          slug,
          kind: body.kind,
          clientId: body.client_id,
          clientSecretEnc: encryptField(getKeyring(), body.client_secret, ssoSecretAad(id)),
          issuer: body.issuer ?? null,
          scopes: body.scopes ?? [],
          enabled: body.enabled,
          autoProvision: body.auto_provision,
          defaultRoleId: body.default_role_id ?? null,
          allowedDomains: body.allowed_domains,
        },
      });
      await audit(actorOf(req), 'SSO_PROVIDER_CREATED', { type: 'sso_provider', id }, { name: body.name, kind: body.kind });
      reply.code(201);
      return serializeProvider(p);
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/sso/providers/:id',
    tag: 'Single Sign-On',
    summary: 'Update an SSO provider',
    auth: 'session',
    permission: 'security.manage',
    requireReauth: true,
    params: z.object({ id: z.string() }),
    body: z
      .object({
        name: providerBody.name.optional(),
        client_id: providerBody.client_id.optional(),
        client_secret: providerBody.client_secret.optional(),
        issuer: providerBody.issuer,
        scopes: providerBody.scopes,
        enabled: z.boolean().optional(),
        auto_provision: z.boolean().optional(),
        default_role_id: z.string().nullable().optional(),
        allowed_domains: providerBody.allowed_domains.optional(),
      })
      .strict(),
    errors: ['not_found', 'reauthentication_required'],
    async handler({ req, params, body }) {
      const p = await getPrisma().ssoProvider.findUnique({ where: { id: params.id } });
      if (!p) throw new AppError('not_found');
      const updated = await getPrisma().ssoProvider.update({
        where: { id: p.id },
        data: {
          name: body.name,
          clientId: body.client_id,
          clientSecretEnc: body.client_secret ? encryptField(getKeyring(), body.client_secret, ssoSecretAad(p.id)) : undefined,
          issuer: body.issuer,
          scopes: body.scopes,
          enabled: body.enabled,
          autoProvision: body.auto_provision,
          defaultRoleId: body.default_role_id,
          allowedDomains: body.allowed_domains,
        },
      });
      await audit(actorOf(req), 'SSO_PROVIDER_UPDATED', { type: 'sso_provider', id: p.id }, { changes: { ...body, client_secret: body.client_secret ? '[changed]' : undefined } });
      return serializeProvider(updated);
    },
  }),
  defineRoute({
    method: 'DELETE',
    url: '/api/v1/sso/providers/:id',
    tag: 'Single Sign-On',
    summary: 'Delete an SSO provider',
    auth: 'session',
    permission: 'security.manage',
    requireReauth: true,
    params: z.object({ id: z.string().refine((v) => isValidId('ssoProvider', v), 'invalid provider id') }),
    errors: ['not_found', 'reauthentication_required'],
    async handler({ req, params, auth }) {
      await enforceReauth(auth as SessionAuth);
      const p = await getPrisma().ssoProvider.findUnique({ where: { id: params.id } });
      if (!p) throw new AppError('not_found');
      await getPrisma().ssoProvider.delete({ where: { id: p.id } });
      await audit(actorOf(req), 'SSO_PROVIDER_DELETED', { type: 'sso_provider', id: p.id }, { name: p.name });
    },
  }),
];

