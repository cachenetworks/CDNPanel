import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { AppError, newId, type ApiErrorBody } from '@cdn/shared';
import { env } from './config/env.js';
import { loggerOptions, redactUrl } from './lib/logger.js';
import { resolveClientIp } from './http/context.js';
import { globalRateLimit } from './http/rateLimitHook.js';
import { authenticate } from './http/authenticate.js';
import { recordRequest } from './lib/requestLog.js';
import { registerAllRoutes } from './routes/index.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { isDeliveryPath } from './http/paths.js';
import { registerAbuseDetection } from './lib/abuse.js';
import { activeTransfers, bytesSent, cacheStatusTotal, httpDuration } from './lib/metrics.js';
import { isBanned } from './services/edgeSecurity.js';

export async function buildApp(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: e.NODE_ENV === 'test' ? false : loggerOptions(e.LOG_LEVEL),
    // A hop count trusts the N closest proxies; lists trust only the given IPs/CIDRs.
    trustProxy: typeof e.trustProxy === 'number' ? (_addr: string, hop: number) => hop < (e.trustProxy as number) : e.trustProxy,
    genReqId: () => newId('request'),
    requestIdHeader: false,
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    // Long-running uploads/downloads are bounded by Nginx and per-route logic.
    connectionTimeout: 0,
    requestTimeout: 0,
    keepAliveTimeout: 65_000,
    routerOptions: { maxParamLength: 512, ignoreTrailingSlash: true },
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(cookie);
  await app.register(cors, {
    delegator: (req, cb) => {
      const url = req.url ?? '/';
      if (isDeliveryPath(url)) {
        // Public CDN content may be embedded anywhere; never with credentials.
        cb(null, { origin: '*', credentials: false, methods: ['GET', 'HEAD'], exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'] });
        return;
      }
      cb(null, {
        origin: e.corsOrigins,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token', 'X-Upload-Checksum', 'Content-Range'],
        exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
        maxAge: 600,
      });
    },
  });
  await app.register(multipart, {
    limits: { fileSize: e.MAX_UPLOAD_SIZE, files: 20, fields: 30, fieldSize: 64 * 1024, parts: 60, headerPairs: 200 },
  });

  // Chunk uploads stream the raw body straight to disk.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  // Plain HTML forms (share-link unlock pages).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  registerAbuseDetection();

  app.decorateRequest('auth', null);
  app.decorateRequest('clientIp', '');
  app.decorateRequest('country', null);
  app.decorateRequest('startedAt', BigInt(0));

  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    const { ip, country } = resolveClientIp(req);
    req.clientIp = ip;
    req.country = country;
    reply.header('X-Request-Id', req.id);
    // Incremented before anything can throw: onResponse always decrements.
    if (isDeliveryPath(req.url)) activeTransfers.inc({ direction: 'out' });
    else if (req.method === 'POST' && (req.url.startsWith('/api/v1/files') || req.url.startsWith('/api/v1/uploads'))) activeTransfers.inc({ direction: 'in' });
    // Banned IPs / networks are refused everywhere except health probes.
    if (!req.url.startsWith('/health') && (await isBanned(ip))) throw new AppError('access_denied', 'Requests from your network are blocked.');
    await globalRateLimit(req, reply);
    await authenticate(req, reply);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!isDeliveryPath(req.url)) {
      // API responses are data, never documents.
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Cross-Origin-Resource-Policy', 'same-site');
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    }
    if (e.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const ms = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    if (isDeliveryPath(req.url)) activeTransfers.dec({ direction: 'out' });
    else if (req.method === 'POST' && (req.url.startsWith('/api/v1/files') || req.url.startsWith('/api/v1/uploads'))) activeTransfers.dec({ direction: 'in' });
    const kind = req.analytics?.kind ?? (req.url.startsWith('/api/') ? 'api' : 'other');
    httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: `${Math.floor(reply.statusCode / 100)}xx`, kind }, ms / 1000);
    if (req.analytics?.bytes) bytesSent.inc({ kind }, req.analytics.bytes);
    if (req.analytics?.cacheStatus) cacheStatusTotal.inc({ status: req.analytics.cacheStatus });
    req.log.info(
      {
        request_id: req.id,
        route: req.routeOptions.url ?? 'unmatched',
        method: req.method,
        url: redactUrl(req.url),
        status: reply.statusCode,
        response_time: Math.round(ms * 100) / 100,
        ip: req.clientIp,
        auth: req.auth ? (req.auth.type === 'session' ? `user:${req.auth.user.id}` : `key:${req.auth.apiKey.id}`) : undefined,
      },
      'request completed',
    );
    if (req.analytics?.fileId) {
      recordRequest({
        timestamp: new Date(),
        fileId: req.analytics.fileId,
        folderId: req.analytics.folderId ?? null,
        apiKeyId: req.auth?.type === 'api_key' ? req.auth.apiKey.id : null,
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        bytesSent: reply.statusCode < 300 ? (req.analytics.bytes ?? 0) : 0,
        responseMs: ms,
        mimeType: req.analytics.mimeType ?? null,
        ip: req.clientIp,
        country: req.country,
        userAgent: req.headers['user-agent'] ?? null,
        kind: req.analytics.kind ?? 'delivery',
        cacheStatus: req.analytics.cacheStatus ?? null,
        zoneId: req.analytics.zoneId ?? null,
        projectId: req.analytics.projectId ?? null,
        cpuMs: req.analytics.cpuMs ?? null,
      });
    } else if (req.url.startsWith('/api/v1/')) {
      recordRequest({
        timestamp: new Date(),
        apiKeyId: req.auth?.type === 'api_key' ? req.auth.apiKey.id : null,
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        bytesSent: Number(reply.getHeader('content-length') ?? 0),
        responseMs: ms,
        ip: req.clientIp,
        country: req.country,
        userAgent: req.headers['user-agent'] ?? null,
        kind: 'api',
      });
    }
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    let appErr: AppError;
    if (err instanceof AppError) appErr = err;
    else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.code === 'FST_REQ_FILE_TOO_LARGE') appErr = new AppError('file_too_large');
    else if (err.code === 'FST_FILES_LIMIT' || err.code === 'FST_PARTS_LIMIT' || err.code === 'FST_FIELDS_LIMIT') appErr = new AppError('bad_request', err.message);
    else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') appErr = new AppError('bad_request', 'Unsupported Content-Type for this endpoint.');
    else if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) appErr = new AppError('bad_request', 'The request body is not valid JSON.');
    else if (err.validation) appErr = new AppError('validation_failed', err.message);
    else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) appErr = new AppError('bad_request', err.message);
    else {
      req.log.error({ err, request_id: req.id }, 'unhandled error');
      appErr = new AppError('internal_error');
    }
    if (appErr.status >= 500 && err instanceof AppError) req.log.error({ err, request_id: req.id }, appErr.code);
    const body: ApiErrorBody = {
      error: { code: appErr.code, message: appErr.message, request_id: req.id, ...(appErr.details !== undefined ? { details: appErr.details } : {}) },
    };
    if (reply.sent) return;
    reply.code(appErr.status).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message: 'The requested resource could not be found.', request_id: req.id } };
    reply.code(404).send(body);
  });

  await registerAllRoutes(app);

  const openapi = buildOpenApiDocument();
  app.get('/openapi.json', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return openapi;
  });
  app.get('/api/v1/openapi.json', async () => openapi);

  return app;
}
