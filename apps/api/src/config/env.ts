import { z } from 'zod';
import { Keyring, parseByteSize } from '@cdn/shared';

/**
 * Environment configuration, validated at startup. The process refuses to boot when
 * security-critical configuration is missing or weak.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').toLowerCase())
  .pipe(z.enum(['', 'true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const urlNoSlash = z
  .string()
  .url()
  .transform((u) => u.replace(/\/+$/, ''));

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be 32 random bytes encoded as base64 (generate with: openssl rand -base64 32)');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(4000),

    APP_URL: urlNoSlash,
    CDN_URL: urlNoSlash,
    API_URL: urlNoSlash,
    /** Extra origins allowed to call the API from browsers (bearer auth only, no cookies). */
    CORS_ORIGINS: z.string().default(''),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    MASTER_ENCRYPTION_KEY: base64Key32,
    MASTER_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
    /** Comma separated "version:base64" list of retired keys still needed for decryption. */
    MASTER_ENCRYPTION_KEYS_PREVIOUS: z.string().default(''),

    STORAGE_DRIVER: z.enum(['LOCAL', 'S3', 'R2', 'MINIO', 'B2']).default('LOCAL'),
    LOCAL_STORAGE_PATH: z.string().default('./data/storage'),
    UPLOAD_TMP_PATH: z.string().default('./data/tmp'),
    /** Additional LOCAL providers created in the dashboard must live beneath this directory. */
    LOCAL_STORAGE_ALLOWED_ROOT: z.string().optional(),
    /** Allow webhook deliveries to private / loopback addresses (off by default to prevent SSRF). */
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: bool,
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    S3_PREFIX: z.string().default(''),

    /** "false", "true" (trust all — never in production), hop count, or comma separated IPs/CIDRs. */
    TRUST_PROXY: z.string().default('false'),
    /** Read CF-Connecting-IP / CF-IPCountry. Only honoured for requests arriving from a trusted proxy. */
    TRUST_CLOUDFLARE_HEADERS: bool,

    MAX_UPLOAD_SIZE: z.string().default('5GB').transform((v, ctx) => {
      try {
        return parseByteSize(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid size' });
        return z.NEVER;
      }
    }),

    /** "stream" (default), "x-accel" (local storage behind Nginx) or "redirect" (S3 presigned URLs). */
    DELIVERY_MODE: z.enum(['stream', 'x-accel', 'redirect']).default('stream'),
    X_ACCEL_PREFIX: z.string().default('/_protected_storage'),

    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

    COOKIE_SECURE: z.string().optional(),

    /** Hostname custom domains should CNAME to (defaults to the CDN_URL host). */
    DOMAIN_CNAME_TARGET: z.string().optional(),
    /** Skip DNS/HTTPS checks and mark custom domains active immediately (development only). */
    DOMAIN_VERIFICATION_DISABLED: bool,
    /** Global Cloudflare credentials for edge purges / cache analytics (zones may override). */
    CLOUDFLARE_API_TOKEN: z.string().optional(),
    CLOUDFLARE_ZONE_ID: z.string().optional(),
    /** Request header carrying the client ASN, set by a trusted proxy (e.g. a Cloudflare transform rule). */
    ASN_HEADER: z.string().default(''),
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    /** Bearer token required for GET /metrics (Prometheus). Empty = metrics only reachable from trusted proxies' networks. */
    METRICS_TOKEN: z.string().default(''),
    /** OTLP/HTTP traces endpoint, e.g. http://otel-collector:4318/v1/traces. Tracing is off when empty. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
    SERVICE_NAME: z.string().default('cdn-api'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER !== 'LOCAL') {
      for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `required when STORAGE_DRIVER=${env.STORAGE_DRIVER}` });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.TRUST_PROXY === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY'],
          message: 'TRUST_PROXY=true trusts every client; configure the proxy IPs/CIDRs explicitly in production',
        });
      }
      if (/change[-_ ]?me|example|placeholder/i.test(env.SESSION_SECRET)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SESSION_SECRET'], message: 'SESSION_SECRET looks like a placeholder' });
      }
      if (env.DELIVERY_MODE === 'redirect' && env.STORAGE_DRIVER === 'LOCAL') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DELIVERY_MODE'], message: 'redirect delivery requires an S3-compatible storage driver' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema> & {
  cookieSecure: boolean;
  corsOrigins: string[];
  trustProxy: boolean | number | string[];
};

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = result.data;
  const cookieSecure = env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.APP_URL.startsWith('https://');
  const corsOrigins = [env.APP_URL, ...env.CORS_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, ''))].filter(Boolean);
  let trustProxy: boolean | number | string[];
  const tp = env.TRUST_PROXY.trim();
  if (tp === '' || tp === 'false') trustProxy = false;
  else if (tp === 'true') trustProxy = true;
  else if (/^\d+$/.test(tp)) trustProxy = Number(tp);
  else trustProxy = tp.split(',').map((s) => s.trim()).filter(Boolean);
  return { ...env, cookieSecure, corsOrigins: [...new Set(corsOrigins)], trustProxy };
}

let cached: Env | undefined;
let keyring: Keyring | undefined;

export function env(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

export function getKeyring(): Keyring {
  if (!keyring) {
    const e = env();
    keyring = Keyring.fromEnv(e.MASTER_ENCRYPTION_KEY, e.MASTER_ENCRYPTION_KEY_VERSION, e.MASTER_ENCRYPTION_KEYS_PREVIOUS);
  }
  return keyring;
}

/** Test helper: reset cached configuration. */
export function resetEnvCache(): void {
  cached = undefined;
  keyring = undefined;
}
