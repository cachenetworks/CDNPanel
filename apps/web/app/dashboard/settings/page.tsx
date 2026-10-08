'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Switch, Textarea, Label } from '@/components/ui/form';
import { ErrorState, KeyValue, PageHeader, Panel, Skeleton } from '@/components/ui/misc';
import { useConfirm, useStepUp } from '@/components/confirm';
import { WebhooksSettings } from '@/components/settings/webhooks';
import { SsoSettings } from '@/components/settings/sso';

type Section = 'general' | 'uploads' | 'files' | 'api' | 'rateLimits' | 'security' | 'retention' | 'analytics' | 'cache' | 'images' | 'media' | 'usage';
type Settings = Record<Section, Record<string, unknown>>;
interface SettingsResponse {
  settings: Settings;
  environment: Record<string, unknown>;
}

type FieldDef =
  | { key: string; label: string; hint?: string; type: 'text' | 'email' }
  | { key: string; label: string; hint?: string; type: 'number'; unit?: string; scale?: number; nullable?: boolean }
  | { key: string; label: string; hint?: string; type: 'bool' }
  | { key: string; label: string; hint?: string; type: 'select'; options: { value: string; label: string }[] }
  | { key: string; label: string; hint?: string; type: 'list'; numeric?: boolean };

interface Tab {
  id: string;
  label: string;
  section?: Section;
  fields?: FieldDef[];
  custom?: 'domains' | 'proxy' | 'webhooks' | 'storage' | 'sso';
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TABS: Tab[] = [
  { id: 'general', label: 'General', section: 'general', fields: [{ key: 'siteName', label: 'Site name', type: 'text' }, { key: 'supportEmail', label: 'Support email', type: 'email' }] },
  { id: 'domains', label: 'Domains', custom: 'domains' },
  {
    id: 'uploads',
    label: 'Uploads',
    section: 'uploads',
    fields: [
      { key: 'maxFileSize', label: 'Maximum file size', type: 'number', unit: 'MB', scale: MB, hint: 'Also capped by MAX_UPLOAD_SIZE in the environment.' },
      { key: 'allowedMimeTypes', label: 'Allowed MIME types', type: 'list', hint: 'One per line, wildcards allowed (image/*). Empty allows all types.' },
      { key: 'blockedExtensions', label: 'Blocked extensions', type: 'list', hint: 'One per line, without the dot.' },
      { key: 'quotaBytes', label: 'Total storage quota', type: 'number', unit: 'GB', scale: GB, nullable: true, hint: 'Empty for unlimited.' },
      { key: 'chunkSize', label: 'Chunk size for resumable uploads', type: 'number', unit: 'MB', scale: MB },
      { key: 'uploadSessionTtlHours', label: 'Resumable upload session lifetime', type: 'number', unit: 'hours' },
      { key: 'deduplicate', label: 'Deduplicate identical content (SHA-256)', type: 'bool' },
      { key: 'requireMalwareScan', label: 'Require malware scan before files become available', type: 'bool', hint: 'Requires CLAMAV_HOST.' },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    section: 'files',
    fields: [
      {
        key: 'defaultVisibility',
        label: 'Default visibility',
        type: 'select',
        options: [
          { value: 'PRIVATE', label: 'Private' },
          { value: 'PUBLIC', label: 'Public' },
          { value: 'AUTHENTICATED', label: 'Authenticated' },
          { value: 'SIGNED_URL_ONLY', label: 'Signed URL only' },
        ],
      },
      { key: 'defaultCacheControl', label: 'Default Cache-Control (public files)', type: 'text' },
      { key: 'privateCacheControl', label: 'Cache-Control for non-public files', type: 'text' },
      { key: 'forceDownloadActiveContent', label: 'Force download for HTML/SVG/XML/JS/PDF', type: 'bool', hint: 'Strongly recommended — prevents stored XSS through uploaded documents.' },
      { key: 'enableFriendlyPaths', label: 'Enable friendly paths (/p/folder/file.ext)', type: 'bool' },
      { key: 'signedUrlDefaultExpiry', label: 'Default signed URL lifetime', type: 'number', unit: 'seconds' },
      { key: 'signedUrlMaxExpiry', label: 'Maximum signed URL lifetime', type: 'number', unit: 'seconds' },
      { key: 'trashRetentionDays', label: 'Recycle bin retention', type: 'number', unit: 'days', hint: 'Deleted files can be restored for this long. 0 deletes immediately.' },
      { key: 'maxVersionsPerFile', label: 'Revisions kept per file', type: 'number', hint: 'Older revisions are pruned daily.' },
    ],
  },
  {
    id: 'cache',
    label: 'Cache',
    section: 'cache',
    fields: [
      { key: 'defaultEdgeTtl', label: 'Default edge TTL (outside zones)', type: 'number', unit: 'seconds', hint: 'Sent as CDN-Cache-Control. Zones and cache rules override it.' },
      { key: 'defaultBrowserTtl', label: 'Default browser TTL (zones)', type: 'number', unit: 'seconds' },
      { key: 'autoPurge', label: 'Purge edge caches automatically when files change', type: 'bool', hint: 'Replacement, rename, move, visibility change and deletion. Needs Cloudflare credentials.' },
      { key: 'prewarmTopFiles', label: 'Pre-warm the most requested files every 6 hours', type: 'number', unit: 'files', hint: '0 disables scheduled pre-warming.' },
    ],
  },
  {
    id: 'images',
    label: 'Images',
    section: 'images',
    fields: [
      { key: 'enabled', label: 'Enable image optimisation (/img/…)', type: 'bool' },
      { key: 'requireSignedTransforms', label: 'Require signed transformation URLs outside zones', type: 'bool', hint: 'Prevents clients from generating unlimited variants.' },
      { key: 'stripMetadata', label: 'Strip EXIF / GPS metadata from variants', type: 'bool' },
      { key: 'defaultQuality', label: 'Default quality', type: 'number' },
      { key: 'maxWidth', label: 'Maximum output width', type: 'number', unit: 'px' },
      { key: 'maxHeight', label: 'Maximum output height', type: 'number', unit: 'px' },
      { key: 'maxSourcePixels', label: 'Maximum source size', type: 'number', unit: 'megapixels', scale: 1_000_000 },
    ],
  },
  {
    id: 'media',
    label: 'Video & audio',
    section: 'media',
    fields: [
      { key: 'enabled', label: 'Process all video / audio uploads', type: 'bool', hint: 'Zones can enable processing individually. Requires FFmpeg in the worker image.' },
      { key: 'renditions', label: 'Renditions', type: 'list', hint: 'One per line: thumbnail, preview, mp4_h264, mp4_h265, webm_av1, hls, dash, audio, waveform.' },
      { key: 'ladder', label: 'HLS / DASH heights', type: 'list', numeric: true, hint: 'One per line, e.g. 360, 720, 1080. Never upscaled.' },
      { key: 'maxDurationSeconds', label: 'Skip media longer than', type: 'number', unit: 'seconds' },
    ],
  },
  { id: 'storage', label: 'Storage', custom: 'storage' },
  {
    id: 'api',
    label: 'API',
    section: 'api',
    fields: [
      { key: 'defaultKeyRateLimit', label: 'Default API key rate limit', type: 'number', unit: 'req/min' },
      { key: 'maxKeyLifetimeDays', label: 'Maximum API key lifetime', type: 'number', unit: 'days', nullable: true, hint: 'Empty allows non-expiring keys.' },
      { key: 'pageSizeMax', label: 'Maximum page size', type: 'number' },
    ],
  },
  {
    id: 'rateLimits',
    label: 'Rate Limits',
    section: 'rateLimits',
    fields: [
      { key: 'globalPerMinute', label: 'Global', type: 'number', unit: 'req/min' },
      { key: 'perIpPerMinute', label: 'Per IP (API)', type: 'number', unit: 'req/min' },
      { key: 'deliveryPerIpPerMinute', label: 'Per IP (file delivery)', type: 'number', unit: 'req/min' },
      { key: 'loginPerIpPer15Min', label: 'Sign-in attempts per IP', type: 'number', unit: 'per 15 min' },
      { key: 'loginPerEmailPer15Min', label: 'Sign-in attempts per account', type: 'number', unit: 'per 15 min' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    section: 'security',
    fields: [
      { key: 'reauthWindowMinutes', label: 'Step-up re-authentication window', type: 'number', unit: 'minutes', hint: 'How long a password confirmation unlocks sensitive actions.' },
      { key: 'lockoutThreshold', label: 'Failed sign-ins before lockout', type: 'number' },
      { key: 'lockoutMinutes', label: 'Lockout duration', type: 'number', unit: 'minutes' },
      { key: 'abuseAutoSuspend', label: 'Suspend API keys automatically after repeated denied requests', type: 'bool' },
      { key: 'abuseThreshold', label: 'Abuse threshold', type: 'number', unit: 'denials' },
      { key: 'abuseWindowMinutes', label: 'Abuse window', type: 'number', unit: 'minutes' },
      { key: 'challengeTtlMinutes', label: 'Browser challenge validity', type: 'number', unit: 'minutes' },
    ],
  },
  {
    id: 'authentication',
    label: 'Authentication',
    section: 'security',
    fields: [
      { key: 'requireTwoFactorForAll', label: 'Require two-factor authentication for all staff', type: 'bool' },
      { key: 'sessionTtlHours', label: 'Session lifetime', type: 'number', unit: 'hours' },
      { key: 'rememberMeDays', label: '“Keep me signed in” lifetime', type: 'number', unit: 'days' },
      { key: 'passwordLoginEnabled', label: 'Allow password sign-in', type: 'bool', hint: 'When off, staff with a passkey or SSO identity must use it. Staff without one can still use their password.' },
    ],
  },
  { id: 'sso', label: 'Single sign-on', custom: 'sso' },
  {
    id: 'retention',
    label: 'Retention',
    section: 'retention',
    fields: [
      { key: 'requestLogDays', label: 'Raw request logs', type: 'number', unit: 'days', hint: 'Older rows are rolled up into daily analytics before deletion.' },
      { key: 'auditLogDays', label: 'Audit logs', type: 'number', unit: 'days' },
      { key: 'securityEventDays', label: 'Security events', type: 'number', unit: 'days' },
      { key: 'webhookDeliveryDays', label: 'Webhook delivery history', type: 'number', unit: 'days' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    section: 'analytics',
    fields: [
      { key: 'enabled', label: 'Record request analytics', type: 'bool' },
      {
        key: 'ipStorage',
        label: 'IP address storage',
        type: 'select',
        options: [
          { value: 'anonymized', label: 'Anonymized (/24 for IPv4, /48 for IPv6)' },
          { value: 'full', label: 'Full IP address' },
          { value: 'none', label: 'Do not store' },
        ],
      },
      { key: 'storeUserAgent', label: 'Store user agents', type: 'bool' },
      { key: 'trackApiRequests', label: 'Track REST API requests (not only file delivery)', type: 'bool' },
    ],
  },
  {
    id: 'usage',
    label: 'Usage & costs',
    section: 'usage',
    fields: [
      { key: 'currency', label: 'Currency for cost estimates', type: 'text', hint: 'Prices are set per storage provider (Storage page).' },
      { key: 'alertWebhooks', label: 'Send quota.threshold webhooks', type: 'bool' },
    ],
  },
  { id: 'proxy', label: 'Proxy / CDN', custom: 'proxy' },
  { id: 'webhooks', label: 'Webhooks', custom: 'webhooks' },
];

function SectionForm({ tab, values, onSaved, editable }: { tab: Tab; values: Record<string, unknown>; onSaved: () => void; editable: boolean }) {
  const stepUp = useStepUp();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const d: Record<string, string | boolean> = {};
    for (const f of tab.fields ?? []) {
      const v = values[f.key];
      if (f.type === 'bool') d[f.key] = Boolean(v);
      else if (f.type === 'list') d[f.key] = ((v as string[]) ?? []).join('\n');
      else if (f.type === 'number') d[f.key] = v === null || v === undefined ? '' : String(Number(v) / (f.scale ?? 1));
      else d[f.key] = String(v ?? '');
    }
    setDraft(d);
  }, [tab, values]);

  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const f of tab.fields ?? []) {
      const v = draft[f.key];
      if (f.type === 'bool') patch[f.key] = v;
      else if (f.type === 'list') {
        const items = String(v)
          .split(/[\n,]/)
          .map((s) => s.trim().replace(/^\./, ''))
          .filter(Boolean);
        patch[f.key] = f.numeric ? items.map(Number).filter((n) => Number.isFinite(n)) : items;
      }
      else if (f.type === 'number') patch[f.key] = v === '' && f.nullable ? null : Math.round(Number(v) * (f.scale ?? 1));
      else patch[f.key] = v;
    }
    setBusy(true);
    await stepUp(
      async () => {
        await api(`/settings/${tab.section}`, { method: 'PATCH', body: patch });
        onSaved();
      },
      { title: 'Confirm settings change', successMessage: 'Settings saved' },
    );
    setBusy(false);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="max-w-2xl space-y-5"
    >
      {(tab.fields ?? []).map((f) =>
        f.type === 'bool' ? (
          <div key={f.key} className="flex items-start justify-between gap-6">
            <div>
              <Label>{f.label}</Label>
              {f.hint && <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>}
            </div>
            <Switch disabled={!editable} checked={Boolean(draft[f.key])} onCheckedChange={(c) => setDraft((d) => ({ ...d, [f.key]: c }))} />
          </div>
        ) : (
          <Field key={f.key} label={f.type === 'number' && f.unit ? `${f.label} (${f.unit})` : f.label} hint={f.hint}>
            {f.type === 'select' ? (
              <NativeSelect className="w-full" disabled={!editable} value={String(draft[f.key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            ) : f.type === 'list' ? (
              <Textarea disabled={!editable} className="min-h-[100px] font-mono text-xs" value={String(draft[f.key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
            ) : (
              <Input disabled={!editable} type={f.type === 'number' ? 'number' : f.type} step="any" className={f.type === 'number' ? 'w-48' : ''} value={String(draft[f.key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
            )}
          </Field>
        ),
      )}
      {editable && (
        <div className="flex gap-2 border-t pt-4">
          <Button type="submit" loading={busy}>
            Save changes
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              confirm({
                title: `Reset ${tab.label} settings to defaults?`,
                destructive: true,
                requireReauth: true,
                confirmLabel: 'Reset',
                successMessage: 'Settings reset',
                action: async () => {
                  await api(`/settings/${tab.section}/reset`, { body: { confirm: true } });
                  onSaved();
                },
              })
            }
          >
            Reset to defaults
          </Button>
        </div>
      )}
    </form>
  );
}

function StorageTab({ uploads, editable, onSaved }: { uploads: Record<string, unknown>; editable: boolean; onSaved: () => void }) {
  const stepUp = useStepUp();
  const providers = useQuery({ queryKey: ['storage-providers'], queryFn: () => api<{ data: { id: string; name: string; kind: string; enabled: boolean; is_default: boolean }[] }>('/storage/providers') });
  return (
    <div className="max-w-2xl space-y-4">
      <Field label="Destination for new uploads" hint="Manage providers and credentials on the Storage page.">
        <NativeSelect
          className="w-full"
          disabled={!editable || !providers.data}
          value={String(uploads.storageProviderId ?? '')}
          onChange={(e) =>
            void stepUp(
              async () => {
                await api('/settings/uploads', { method: 'PATCH', body: { storageProviderId: e.target.value || null } });
                onSaved();
              },
              { title: 'Confirm storage change', successMessage: 'Upload destination updated' },
            )
          }
        >
          <option value="">Default provider</option>
          {(providers.data?.data ?? [])
            .filter((p) => p.enabled)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind})
              </option>
            ))}
        </NativeSelect>
      </Field>
      {providers.isError && <p className="text-sm text-muted-foreground">Viewing providers requires the storage.manage permission.</p>}
    </div>
  );
}

export default function SettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = React.useState('general');
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });
  const current = TABS.find((t) => t.id === tab)!;
  const editable = can('settings.edit');
  const env = q.data?.environment ?? {};
  const refresh = () => void qc.invalidateQueries({ queryKey: ['settings'] });

  return (
    <>
      <PageHeader title="Settings" description={editable ? 'Changes apply immediately. Security-sensitive sections ask you to confirm your password.' : 'You have read-only access to settings.'} />
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn('whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground', tab === t.id && 'bg-accent font-medium text-foreground')}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <h2 className="mb-4 text-base font-semibold">{current.label}</h2>
          {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {!q.data ? (
            <Skeleton className="h-64" />
          ) : current.section ? (
            <SectionForm tab={current} values={q.data.settings[current.section]} editable={editable} onSaved={refresh} />
          ) : current.custom === 'domains' ? (
            <Panel className="max-w-2xl p-4">
              <p className="mb-4 text-sm text-muted-foreground">Domains are configured with environment variables (APP_URL, CDN_URL, API_URL, CORS_ORIGINS) and require a restart to change.</p>
              <KeyValue
                items={[
                  ['Dashboard (APP_URL)', <code key="a">{String(env.app_url)}</code>],
                  ['CDN (CDN_URL)', <code key="c">{String(env.cdn_url)}</code>],
                  ['API (API_URL)', <code key="p">{String(env.api_url)}</code>],
                  ['Allowed CORS origins', <code key="o">{(env.cors_origins as string[] | undefined)?.join(', ')}</code>],
                ]}
              />
            </Panel>
          ) : current.custom === 'proxy' ? (
            <Panel className="max-w-2xl p-4">
              <p className="mb-4 text-sm text-muted-foreground">Reverse-proxy and delivery settings come from the environment. See the README section “Cloudflare” before changing them.</p>
              <KeyValue
                items={[
                  ['Trusted proxies (TRUST_PROXY)', <code key="t">{String(env.trust_proxy)}</code>],
                  ['Read Cloudflare headers', String(env.trust_cloudflare_headers)],
                  ['Delivery mode', <code key="d">{String(env.delivery_mode)}</code>],
                  ['Storage driver (env)', String(env.storage_driver)],
                  ['Max upload size (env)', formatBytes(Number(env.max_upload_size))],
                  ['Malware scanner', String(env.malware_scanner ?? 'not configured')],
                  ['Secure cookies', String(env.secure_cookies)],
                  ['Encryption key version', String(env.encryption_key_version)],
                ]}
              />
            </Panel>
          ) : current.custom === 'storage' ? (
            <StorageTab uploads={q.data.settings.uploads} editable={editable} onSaved={refresh} />
          ) : current.custom === 'sso' ? (
            <SsoSettings editable={editable} />
          ) : (
            <WebhooksSettings editable={editable} />
          )}
        </div>
      </div>
    </>
  );
}
