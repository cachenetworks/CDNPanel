import pino, { type LoggerOptions } from 'pino';

/** Paths that must never reach the logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.api_key',
  '*.apiKey',
  '*.key',
  '*.secret',
  '*.secretAccessKey',
  '*.totpSecret',
  'password',
  'token',
  'api_key',
  'secret',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: process.env.SERVICE_NAME ?? 'cdn-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: {
      // Only log a safe subset of request properties — never the full header set.
      req(req: { id?: string; method?: string; url?: string; routeOptions?: { url?: string }; ip?: string }) {
        return {
          request_id: req.id,
          method: req.method,
          url: redactUrl(req.url ?? ''),
          route: req.routeOptions?.url,
          ip: req.ip,
        };
      },
      res(res: { statusCode?: number }) {
        return { status: res.statusCode };
      },
    },
  };
}

/** Removes signed-URL signatures and other secrets from logged URLs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:sig|token|signature|api_key|key)=)[^&]*/gi, '$1[REDACTED]');
}

export const baseLogger = pino(loggerOptions(process.env.LOG_LEVEL ?? 'info'));
