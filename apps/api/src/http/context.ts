import type { FastifyRequest } from 'fastify';
import type { ApiScope, Permission } from '@cdn/shared';
import type { AuditContext } from '../lib/audit.js';
import { env } from '../config/env.js';
import { ipMatchesAny } from '../lib/ip.js';
import ipaddr from 'ipaddr.js';

export interface SessionAuth {
  type: 'session';
  user: {
    id: string;
    email: string;
    name: string;
    totpEnabled: boolean;
    requireTwoFactor: boolean;
  };
  session: { id: string; reauthAt: Date | null; createdAt: Date };
  permissions: Set<Permission>;
  roleIds: string[];
  roleNames: string[];
  /** Raw session token — needed to derive the CSRF token. Never logged or returned. */
  token: string;
}

export interface ApiKeyAuth {
  type: 'api_key';
  apiKey: {
    id: string;
    name: string;
    prefix: string;
    environment: 'LIVE' | 'TEST';
    allowedEndpoints: string[];
    /** Keys bound to a project may only touch files inside that project's zones. */
    projectId: string | null;
    serviceAccountId: string | null;
  };
  scopes: Set<ApiScope>;
}

export type AuthContext = SessionAuth | ApiKeyAuth;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    clientIp: string;
    country: string | null;
    startedAt: bigint;
    /** Set by delivery routes so analytics can attribute the request. */
    analytics?: {
      fileId?: string;
      folderId?: string | null;
      mimeType?: string;
      bytes?: number;
      cacheStatus?: string;
      zoneId?: string | null;
      projectId?: string | null;
      /** delivery | transform | media | share */
      kind?: 'delivery' | 'transform' | 'media' | 'share';
      cpuMs?: number;
    };
  }
}

function isTrustedPeer(peer: string | undefined): boolean {
  const tp = env().trustProxy;
  if (!peer) return false;
  if (tp === true) return true;
  if (tp === false) return false;
  if (typeof tp === 'number') return tp > 0;
  return ipMatchesAny(peer, tp);
}

/**
 * Resolves the client IP. X-Forwarded-For handling is delegated to Fastify's `trustProxy`
 * (only honoured from configured proxies). Cloudflare headers are only read when explicitly
 * enabled AND the TCP peer is a trusted proxy, so they cannot be spoofed by direct clients.
 */
export function resolveClientIp(req: FastifyRequest): { ip: string; country: string | null } {
  const e = env();
  const peer = req.socket.remoteAddress;
  if (e.TRUST_CLOUDFLARE_HEADERS && isTrustedPeer(peer)) {
    const cfIp = req.headers['cf-connecting-ip'];
    const cfCountry = req.headers['cf-ipcountry'];
    const ip = typeof cfIp === 'string' && ipaddr.isValid(cfIp.trim()) ? cfIp.trim() : req.ip;
    const country = typeof cfCountry === 'string' && /^[A-Z]{2}$/.test(cfCountry) && cfCountry !== 'XX' ? cfCountry : null;
    return { ip, country };
  }
  return { ip: req.ip, country: null };
}

export function actorOf(req: FastifyRequest): AuditContext {
  const a = req.auth;
  const base = { ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null };
  if (!a) return { ...base, actorType: 'system' };
  if (a.type === 'session') return { ...base, actorId: a.user.id, actorType: 'user', actorLabel: a.user.email };
  return { ...base, actorId: a.apiKey.id, actorType: 'api_key', actorLabel: `${a.apiKey.name} (${a.apiKey.prefix})` };
}

export function userIdOf(req: FastifyRequest): string | null {
  return req.auth?.type === 'session' ? req.auth.user.id : null;
}

export function apiKeyIdOf(req: FastifyRequest): string | null {
  return req.auth?.type === 'api_key' ? req.auth.apiKey.id : null;
}

/** Whether the caller may perform an action identified by a staff permission or API scope. */
export function can(req: FastifyRequest, permission: Permission, scope?: ApiScope): boolean {
  const a = req.auth;
  if (!a) return false;
  if (a.type === 'session') return a.permissions.has(permission);
  return scope ? a.scopes.has(scope) : false;
}
