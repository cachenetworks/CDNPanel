import { z } from 'zod';
import { getPrisma } from '@cdn/database';
import { DEFAULT_BLOCKED_EXTENSIONS } from '@cdn/shared';

/**
 * Runtime-editable settings, stored per section in the Setting table and validated with zod.
 * Defaults apply for anything not yet stored.
 */

const visibility = z.enum(['PUBLIC', 'PRIVATE', 'AUTHENTICATED', 'SIGNED_URL_ONLY']);

export const SettingsSchemas = {
  general: z.object({
    siteName: z.string().min(1).max(80).default('CDN'),
    supportEmail: z.string().email().or(z.literal('')).default(''),
  }),
  uploads: z.object({
    /** Bytes. Effective limit is min(this, MAX_UPLOAD_SIZE env). */
    maxFileSize: z.number().int().positive().default(5 * 1024 ** 3),
    /** MIME patterns (e.g. image/*). Empty = allow all (subject to blocked extensions). */
    allowedMimeTypes: z.array(z.string().min(1).max(100)).max(200).default([]),
    blockedExtensions: z.array(z.string().regex(/^[a-z0-9]{1,16}$/)).max(500).default(DEFAULT_BLOCKED_EXTENSIONS),
    /** Total storage quota in bytes across all files (null = unlimited). */
    quotaBytes: z.number().int().positive().nullable().default(null),
    chunkSize: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024).default(16 * 1024 * 1024),
    /** Reuse stored objects when an identical SHA-256 already exists. */
    deduplicate: z.boolean().default(true),
    /** Require a successful malware scan before files become READY (needs CLAMAV_HOST). */
    requireMalwareScan: z.boolean().default(false),
    /** Storage provider for new uploads (null = default provider). */
    storageProviderId: z.string().nullable().default(null),
    uploadSessionTtlHours: z.number().int().min(1).max(168).default(24),
  }),
  files: z.object({
    defaultVisibility: visibility.default('PRIVATE'),
    defaultCacheControl: z.string().max(200).default('public, max-age=31536000, immutable'),
    privateCacheControl: z.string().max(200).default('private, no-store'),
    /** Serve HTML/SVG/XML/JS/PDF as attachments with a sandbox CSP. */
    forceDownloadActiveContent: z.boolean().default(true),
    enableFriendlyPaths: z.boolean().default(true),
    signedUrlDefaultExpiry: z.number().int().min(10).max(7 * 24 * 3600).default(3600),
    signedUrlMaxExpiry: z.number().int().min(60).max(30 * 24 * 3600).default(7 * 24 * 3600),
  }),
  api: z.object({
    defaultKeyRateLimit: z.number().int().min(1).max(100000).default(600),
    maxKeyLifetimeDays: z.number().int().min(1).max(3650).nullable().default(null),
    pageSizeMax: z.number().int().min(10).max(500).default(200),
  }),
  rateLimits: z.object({
    globalPerMinute: z.number().int().min(10).default(20000),
    perIpPerMinute: z.number().int().min(10).default(1200),
    deliveryPerIpPerMinute: z.number().int().min(10).default(6000),
    loginPerIpPer15Min: z.number().int().min(3).default(30),
    loginPerEmailPer15Min: z.number().int().min(3).default(10),
  }),
  security: z.object({
    sessionTtlHours: z.number().int().min(1).max(168).default(12),
    rememberMeDays: z.number().int().min(1).max(90).default(30),
    requireTwoFactorForAll: z.boolean().default(false),
    lockoutThreshold: z.number().int().min(3).max(100).default(8),
    lockoutMinutes: z.number().int().min(1).max(1440).default(15),
    reauthWindowMinutes: z.number().int().min(1).max(60).default(10),
  }),
  retention: z.object({
    requestLogDays: z.number().int().min(1).max(3650).default(30),
    auditLogDays: z.number().int().min(30).max(3650).default(365),
    securityEventDays: z.number().int().min(7).max(3650).default(90),
    webhookDeliveryDays: z.number().int().min(1).max(365).default(30),
  }),
  analytics: z.object({
    enabled: z.boolean().default(true),
    ipStorage: z.enum(['none', 'anonymized', 'full']).default('anonymized'),
    storeUserAgent: z.boolean().default(true),
    trackApiRequests: z.boolean().default(true),
  }),
} as const;

export type SettingsSection = keyof typeof SettingsSchemas;
export type Settings = { [K in SettingsSection]: z.infer<(typeof SettingsSchemas)[K]> };
export const SETTINGS_SECTIONS = Object.keys(SettingsSchemas) as SettingsSection[];

const CACHE_TTL_MS = 5_000;
let cache: { at: number; value: Settings } | null = null;

export function defaultSettings(): Settings {
  const out = {} as Record<string, unknown>;
  for (const s of SETTINGS_SECTIONS) out[s] = SettingsSchemas[s].parse({});
  return out as Settings;
}

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const rows = await getPrisma().setting.findMany({ where: { key: { in: SETTINGS_SECTIONS } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, unknown>;
  for (const s of SETTINGS_SECTIONS) {
    const parsed = SettingsSchemas[s].safeParse(stored.get(s) ?? {});
    out[s] = parsed.success ? parsed.data : SettingsSchemas[s].parse({});
  }
  cache = { at: Date.now(), value: out as Settings };
  return cache.value;
}

export async function updateSettingsSection<K extends SettingsSection>(
  section: K,
  patch: unknown,
  updatedBy: string | null,
): Promise<{ before: Settings[K]; after: Settings[K] }> {
  const current = (await getSettings())[section];
  const merged = SettingsSchemas[section].parse({ ...current, ...(patch as object) }) as Settings[K];
  await getPrisma().setting.upsert({
    where: { key: section },
    create: { key: section, value: merged as object, updatedBy },
    update: { value: merged as object, updatedBy },
  });
  cache = null;
  return { before: current, after: merged };
}

export async function resetSettingsSection(section: SettingsSection, updatedBy: string | null): Promise<void> {
  await getPrisma().setting.deleteMany({ where: { key: section } });
  void updatedBy;
  cache = null;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
