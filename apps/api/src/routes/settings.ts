import { z } from 'zod';
import { AppError } from '@cdn/shared';
import { defineRoute, enforceReauth, type RouteDef } from '../http/route.js';
import { actorOf, type SessionAuth } from '../http/context.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { SETTINGS_SECTIONS, SettingsSchemas, getSettings, resetSettingsSection, updateSettingsSection, type SettingsSection } from '../lib/settings.js';
import { getPrisma } from '@cdn/database';

const sectionParam = z.object({ section: z.enum(SETTINGS_SECTIONS as [SettingsSection, ...SettingsSection[]]) });
/** Sections whose changes weaken or strengthen security posture require step-up auth. */
const SENSITIVE_SECTIONS: SettingsSection[] = ['security', 'rateLimits', 'uploads', 'retention'];

function environmentInfo() {
  const e = env();
  return {
    app_url: e.APP_URL,
    cdn_url: e.CDN_URL,
    api_url: e.API_URL,
    cors_origins: e.corsOrigins,
    trust_proxy: e.TRUST_PROXY,
    trust_cloudflare_headers: e.TRUST_CLOUDFLARE_HEADERS,
    delivery_mode: e.DELIVERY_MODE,
    storage_driver: e.STORAGE_DRIVER,
    max_upload_size: e.MAX_UPLOAD_SIZE,
    malware_scanner: e.CLAMAV_HOST ? 'clamav' : null,
    secure_cookies: e.cookieSecure,
    encryption_key_version: e.MASTER_ENCRYPTION_KEY_VERSION,
    node_env: e.NODE_ENV,
  };
}

export const settingsRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/settings',
    tag: 'Settings',
    summary: 'Get all settings',
    description: 'Returns runtime-editable settings for every section plus read-only environment configuration (domains, proxy, delivery).',
    auth: 'session',
    permission: 'settings.view',
    responses: { 200: { description: 'Settings' } },
    async handler() {
      const settings = await getSettings();
      const rows = await getPrisma().setting.findMany({ select: { key: true, updatedAt: true, updatedBy: true } });
      return { settings, environment: environmentInfo(), updated: Object.fromEntries(rows.map((r) => [r.key, { at: r.updatedAt.toISOString(), by: r.updatedBy }])) };
    },
  }),
  defineRoute({
    method: 'PATCH',
    url: '/api/v1/settings/:section',
    tag: 'Settings',
    summary: 'Update a settings section',
    description: `Partially updates one section (${SETTINGS_SECTIONS.join(', ')}). Changes to security, rate limit, upload and retention settings require a recent re-authentication.`,
    auth: 'session',
    permission: 'settings.edit',
    params: sectionParam,
    body: z.record(z.unknown()),
    responses: { 200: { description: 'Updated section' } },
    errors: ['validation_failed', 'reauthentication_required'],
    async handler({ req, params, body, auth }) {
      const section = params.section as SettingsSection;
      if (SENSITIVE_SECTIONS.includes(section)) await enforceReauth(auth as SessionAuth);
      const partial = SettingsSchemas[section].partial().strict().safeParse(body);
      if (!partial.success) {
        throw new AppError('validation_failed', undefined, partial.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      const patch = partial.data as Record<string, unknown>;
      if (section === 'uploads' && patch.requireMalwareScan === true && !env().CLAMAV_HOST) {
        throw new AppError('validation_failed', 'Malware scanning cannot be required because no scanner is configured (set CLAMAV_HOST).');
      }
      if (section === 'uploads' && typeof patch.storageProviderId === 'string') {
        const p = await getPrisma().storageProvider.findFirst({ where: { id: patch.storageProviderId, enabled: true } });
        if (!p) throw new AppError('validation_failed', 'Unknown or disabled storage provider.');
      }
      const { before, after } = await updateSettingsSection(section, patch, (auth as SessionAuth).user.id);
      const changed = Object.keys(patch).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
      await audit(actorOf(req), 'SETTINGS_UPDATED', { type: 'settings', id: section }, {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
      });
      return { section, settings: after };
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/api/v1/settings/:section/reset',
    tag: 'Settings',
    summary: 'Reset a settings section to defaults',
    auth: 'session',
    permission: 'settings.edit',
    requireReauth: true,
    params: sectionParam,
    body: z.object({ confirm: z.literal(true) }),
    responses: { 200: { description: 'Section defaults' } },
    errors: ['reauthentication_required'],
    async handler({ req, params, auth }) {
      const section = params.section as SettingsSection;
      await resetSettingsSection(section, (auth as SessionAuth).user.id);
      await audit(actorOf(req), 'SETTINGS_RESET', { type: 'settings', id: section });
      return { section, settings: (await getSettings())[section] };
    },
  }),
];
