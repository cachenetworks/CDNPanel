import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { AppError, type ApiScope, type ErrorCode, type Permission } from '@cdn/shared';
import { endpointMatches } from '@cdn/shared';
import type { AuthContext, SessionAuth } from './context.js';
import { verifyCsrf } from './csrf.js';
import { getSettings } from '../lib/settings.js';
import { securityEvent } from '../lib/audit.js';
import { getRateLimiter, applyRateLimitHeaders, logRateLimitOnce } from './rateLimitHook.js';

/**
 * Declarative route definition. A single definition drives:
 *  - Fastify registration
 *  - request validation (zod)
 *  - authentication mode, RBAC permission and API-key scope enforcement (server-side)
 *  - CSRF and step-up re-authentication checks
 *  - per-route rate limits
 *  - the OpenAPI document and the in-dashboard API reference
 */

export type AuthMode =
  /** No authentication. */
  | 'public'
  /** Staff cookie session only (administrative endpoints). */
  | 'session'
  /** Staff session (checked against `permission`) or API key (checked against `scope`). */
  | 'any';

export type DocTag =
  | 'Account'
  | 'Authentication'
  | 'Files'
  | 'Uploads'
  | 'Folders'
  | 'Signed URLs'
  | 'Analytics'
  | 'API Keys'
  | 'Users'
  | 'Roles'
  | 'Security'
  | 'Audit Logs'
  | 'Settings'
  | 'Storage'
  | 'Webhooks'
  | 'Dashboard'
  | 'Delivery'
  | 'Health';

export interface ResponseDoc {
  description: string;
  example?: unknown;
  contentType?: string;
}

export interface MultipartFieldDoc {
  name: string;
  type: 'file' | 'string' | 'boolean' | 'integer';
  required?: boolean;
  description: string;
  enum?: string[];
}

export interface HandlerContext<P, Q, B> {
  req: FastifyRequest;
  reply: FastifyReply;
  params: P;
  query: Q;
  body: B;
  auth: AuthContext | null;
}

export interface RouteDef<P extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny, B extends ZodTypeAny = ZodTypeAny> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';
  url: string;
  tag: DocTag;
  summary: string;
  description?: string;
  auth: AuthMode;
  permission?: Permission | Permission[];
  scope?: ApiScope | ApiScope[];
  params?: P;
  query?: Q;
  body?: B;
  /** For multipart endpoints the body is streamed by the handler; fields are documented here. */
  multipart?: MultipartFieldDoc[];
  /** Raw binary body (chunk uploads). */
  rawBody?: { contentType: string; description: string };
  responses?: Record<number, ResponseDoc>;
  errors?: ErrorCode[];
  rateLimit?: { name: string; max: number; windowSeconds: number };
  /** Require a password re-authentication within the configured window (session only). */
  requireReauth?: boolean;
  /** Allow access while the user still has to enroll in 2FA. */
  allowDuringMfaEnrollment?: boolean;
  /** With auth 'any': accept any valid API key regardless of scopes (e.g. GET /me). */
  allowAnyApiKey?: boolean;
  /** Skip CSRF validation (only for unauthenticated endpoints such as login). */
  skipCsrf?: boolean;
  /** Example request body for docs/code samples (otherwise derived from the schema). */
  bodyExample?: unknown;
  /** Exclude from the OpenAPI document. */
  hidden?: boolean;
  bodyLimit?: number;
  handler: (ctx: HandlerContext<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<unknown>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function parseOrThrow<T extends ZodTypeAny>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return value as z.infer<T>;
  const res = schema.safeParse(value ?? {});
  if (!res.success) {
    throw new AppError(
      'validation_failed',
      undefined,
      res.error.issues.map((i) => ({ location: where, path: i.path.join('.'), message: i.message })),
    );
  }
  return res.data;
}

async function enforceAuth(def: RouteDef, req: FastifyRequest): Promise<void> {
  if (def.auth === 'public') return;
  const auth = req.auth;
  if (!auth) throw new AppError('unauthenticated');

  if (auth.type === 'api_key') {
    const scopes = asArray(def.scope);
    if (def.auth === 'session' || (scopes.length === 0 && !def.allowAnyApiKey)) throw new AppError('staff_session_required');
    const path = (req.routeOptions.url ?? req.url).split('?')[0]!;
    const actualPath = req.url.split('?')[0]!;
    if (
      auth.apiKey.allowedEndpoints.length > 0 &&
      !auth.apiKey.allowedEndpoints.some((p) => endpointMatches(p, req.method, actualPath) || endpointMatches(p, req.method, path))
    ) {
      void securityEvent('API_KEY_ENDPOINT_BLOCKED', { ip: req.clientIp, apiKeyId: auth.apiKey.id, details: { method: req.method, path: actualPath } });
      throw new AppError('endpoint_not_allowed');
    }
    const missing = scopes.filter((s) => !auth.scopes.has(s));
    if (missing.length > 0) {
      void securityEvent('API_KEY_SCOPE_DENIED', { ip: req.clientIp, apiKeyId: auth.apiKey.id, severity: 'info', details: { missing } });
      throw new AppError('insufficient_scope', `The API key is missing the required scope: ${missing.join(', ')}.`, { required: scopes });
    }
    return;
  }

  // Staff session
  if (!def.allowDuringMfaEnrollment && !auth.user.totpEnabled) {
    const settings = await getSettings();
    if (auth.user.requireTwoFactor || settings.security.requireTwoFactorForAll) {
      throw new AppError('two_factor_enrollment_required');
    }
  }
  if (MUTATING.has(req.method) && !def.skipCsrf) verifyCsrf(req, auth);
  const perms = asArray(def.permission);
  const missing = perms.filter((p) => !auth.permissions.has(p));
  if (missing.length > 0) {
    void securityEvent('PERMISSION_DENIED', {
      ip: req.clientIp,
      userId: auth.user.id,
      severity: 'info',
      details: { route: `${req.method} ${req.routeOptions.url}`, missing },
    });
    throw new AppError('forbidden', undefined, { required: perms });
  }
  if (def.requireReauth) await enforceReauth(auth);
}

export async function enforceReauth(auth: SessionAuth): Promise<void> {
  const settings = await getSettings();
  const windowMs = settings.security.reauthWindowMinutes * 60_000;
  if (!auth.session.reauthAt || Date.now() - auth.session.reauthAt.getTime() > windowMs) {
    throw new AppError('reauthentication_required');
  }
}

export function defineRoute<P extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny, B extends ZodTypeAny = ZodTypeAny>(
  def: RouteDef<P, Q, B>,
): RouteDef<P, Q, B> {
  return def;
}

export function registerRoutes(app: FastifyInstance, defs: RouteDef<any, any, any>[]): void {
  for (const def of defs) {
    app.route({
      method: def.method as HTTPMethods,
      url: def.url,
      bodyLimit: def.bodyLimit,
      handler: async (req, reply) => {
        if (def.rateLimit) {
          const who = req.auth?.type === 'api_key' ? `k:${req.auth.apiKey.id}` : req.auth?.type === 'session' ? `u:${req.auth.user.id}` : `ip:${req.clientIp}`;
          const rl = await getRateLimiter().hit(`route:${def.rateLimit.name}:${who}`, def.rateLimit.max, def.rateLimit.windowSeconds);
          applyRateLimitHeaders(reply, rl);
          if (!rl.allowed) {
            await logRateLimitOnce(req.clientIp, `route:${def.rateLimit.name}`, req.url.split('?')[0]!);
            reply.header('Retry-After', String(rl.retryAfter));
            throw new AppError('rate_limited');
          }
        }
        await enforceAuth(def as RouteDef, req);
        const params = parseOrThrow(def.params, req.params, 'path');
        const query = parseOrThrow(def.query, req.query, 'query');
        const body = def.multipart || def.rawBody ? undefined : parseOrThrow(def.body, req.body, 'body');
        const result = await def.handler({ req, reply, params, query, body: body as never, auth: req.auth });
        if (reply.sent) return reply;
        if (result === undefined) {
          if (reply.statusCode === 200) reply.code(204);
          return reply.send();
        }
        return reply.send(result);
      },
    });
  }
}

// Shared zod helpers ---------------------------------------------------------

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export function paginate<T>(items: T[], total: number, page: number, limit: number) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return {
    data: items,
    pagination: { page, limit, total, total_pages: pages, has_more: page < pages },
  };
}

/** Coerces "true"/"false" query string values. */
export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
