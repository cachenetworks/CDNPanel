'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check } from 'lucide-react';
import { API_SCOPES, type ApiScope } from '@cdn/shared/permissions';
import { api, errorMessage } from '@/lib/api';
import type { ApiKeyDTO, ProjectDTO } from '@/lib/types';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '../ui/form';
import { CopyButton } from '../ui/misc';

const STEPS = ['Name', 'Scopes', 'Restrictions', 'Expiration', 'Generate'] as const;

const PRESETS: { label: string; scopes: ApiScope[] }[] = [
  { label: 'Read only', scopes: ['files:read', 'folders:read', 'metadata:read'] },
  { label: 'Uploader', scopes: ['files:read', 'files:upload', 'folders:read'] },
  { label: 'Full access', scopes: Object.keys(API_SCOPES) as ApiScope[] },
];

function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Wizard: name → scopes → restrictions → expiration → generate → shown once. */
interface Template {
  id: string;
  name: string;
  scopes: ApiScope[];
  rate_limit: number | null;
  ip_restrictions: string[];
  allowed_endpoints: string[];
  expires_in_days: number | null;
  environment: 'live' | 'test';
}

export function CreateKeyDialog({ open, onOpenChange, defaultServiceAccount }: { open: boolean; onOpenChange: (o: boolean) => void; defaultServiceAccount?: string }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [step, setStep] = React.useState(0);
  const [projectId, setProjectId] = React.useState('');
  const [serviceAccountId, setServiceAccountId] = React.useState('');
  const [templateId, setTemplateId] = React.useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ data: ProjectDTO[] }>('/projects'), enabled: open && can('zones.view') });
  const accounts = useQuery({ queryKey: ['service-accounts'], queryFn: () => api<{ data: { id: string; name: string; project: { id: string } | null }[] }>('/service-accounts'), enabled: open });
  const templates = useQuery({ queryKey: ['api-key-templates'], queryFn: () => api<{ data: Template[] }>('/api-key-templates'), enabled: open });
  const [name, setName] = React.useState('');
  const [environment, setEnvironment] = React.useState<'live' | 'test'>('live');
  const [notes, setNotes] = React.useState('');
  const [scopes, setScopes] = React.useState<ApiScope[]>(['files:read']);
  const [ips, setIps] = React.useState('');
  const [endpoints, setEndpoints] = React.useState('');
  const [rateLimit, setRateLimit] = React.useState('');
  const [expiry, setExpiry] = React.useState('never');
  const [customExpiry, setCustomExpiry] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{ key: string; api_key: ApiKeyDTO } | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      // Drop the secret from memory as soon as the dialog closes.
      setCreated(null);
      setStep(0);
      setName('');
      setNotes('');
      setScopes(['files:read']);
      setIps('');
      setEndpoints('');
      setRateLimit('');
      setExpiry('never');
      setCustomExpiry('');
      setError(null);
      setAcknowledged(false);
      setProjectId('');
      setTemplateId('');
    }
    if (open) setServiceAccountId(defaultServiceAccount ?? '');
  }, [open, defaultServiceAccount]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.data?.data.find((x) => x.id === id);
    if (!t) return;
    setScopes(t.scopes);
    setEnvironment(t.environment);
    setIps(t.ip_restrictions.join('\n'));
    setEndpoints(t.allowed_endpoints.join('\n'));
    setRateLimit(t.rate_limit ? String(t.rate_limit) : '');
    setExpiry(t.expires_in_days ? String(t.expires_in_days) : 'never');
  };

  const expiresAt = (): string | null => {
    if (expiry === 'never') return null;
    if (expiry === 'custom') return customExpiry ? new Date(customExpiry).toISOString() : null;
    return new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
  };

  const canNext = step === 0 ? name.trim().length > 0 : step === 1 ? scopes.length > 0 : step === 3 ? expiry !== 'custom' || Boolean(customExpiry) : true;

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ key: string; api_key: ApiKeyDTO }>('/api-keys', {
        body: {
          name: name.trim(),
          environment,
          scopes,
          ip_restrictions: lines(ips),
          allowed_endpoints: lines(endpoints),
          rate_limit: rateLimit ? Number(rateLimit) : null,
          expires_at: expiresAt(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(serviceAccountId ? { service_account_id: serviceAccountId } : {}),
        },
      });
      setCreated(res);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && created && !acknowledged) return; // must confirm the key was copied
        onOpenChange(o);
      }}
    >
      <DialogContent size="lg" onEscapeKeyDown={(e) => created && !acknowledged && e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()}>
        {created ? (
          <>
            <DialogHeader title="API key created" />
            <DialogBody>
              <div className="flex gap-3 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="text-sm">
                  <p className="font-semibold">IMPORTANT: Copy this API key now.</p>
                  <p className="text-muted-foreground">You will not be able to view it again. Only a hash is stored on the server.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-subtle p-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{created.key}</code>
              </div>
              <CopyButton value={created.key} label="API key copied">
                Copy API Key
              </CopyButton>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={acknowledged} onCheckedChange={(c) => setAcknowledged(c === true)} />
                I have stored this key securely.
              </label>
            </DialogBody>
            <DialogFooter>
              <Button disabled={!acknowledged} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader title="Create API key" />
            <ol className="flex border-b px-5 text-xs">
              {STEPS.map((s, i) => (
                <li key={s} className={cn('-mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2.5 pr-4 text-muted-foreground', i === step && 'border-primary text-foreground', i < step && 'text-foreground')}>
                  <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border text-[10px]', i < step && 'border-primary bg-primary text-primary-foreground')}>{i < step ? <Check className="h-3 w-3" /> : i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
            <DialogBody className="min-h-[300px]">
              {step === 0 && (
                <>
                  <Field label="Name" hint="Describe where the key is used, e.g. “Release pipeline”.">
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
                  </Field>
                  <Field label="Environment">
                    <NativeSelect value={environment} onChange={(e) => setEnvironment(e.target.value as 'live' | 'test')}>
                      <option value="live">Live (cdn_live_…)</option>
                      <option value="test">Test (cdn_test_…)</option>
                    </NativeSelect>
                  </Field>
                  {(templates.data?.data.length ?? 0) > 0 && (
                    <Field label="Template (optional)" hint="Pre-fills scopes, restrictions and lifetime.">
                      <NativeSelect value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                        <option value="">No template</option>
                        {templates.data!.data.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    {projects.data && (
                      <Field label="Project scope" hint="Bound keys can only reach that project's zones.">
                        <NativeSelect className="w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                          <option value="">All files (unbound)</option>
                          {projects.data.data.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                    )}
                    {(accounts.data?.data.length ?? 0) > 0 && (
                      <Field label="Owner" hint="Service accounts own keys for machines.">
                        <NativeSelect className="w-full" value={serviceAccountId} onChange={(e) => setServiceAccountId(e.target.value)}>
                          <option value="">Me</option>
                          {accounts.data!.data.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} (service account)
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                    )}
                  </div>
                  <Field label="Notes (optional, stored encrypted)">
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
                  </Field>
                </>
              )}
              {step === 1 && (
                <>
                  <div className="flex gap-2">
                    {PRESETS.map((p) => (
                      <Button key={p.label} type="button" size="xs" variant="secondary" onClick={() => setScopes(p.scopes)}>
                        {p.label}
                      </Button>
                    ))}
                  </div>
                  <div className="divide-y rounded-md border">
                    {(Object.entries(API_SCOPES) as [ApiScope, string][]).map(([scope, desc]) => (
                      <label key={scope} className="flex items-start gap-3 px-3 py-2">
                        <Checkbox className="mt-0.5" checked={scopes.includes(scope)} onCheckedChange={(c) => setScopes((prev) => (c === true ? [...prev, scope] : prev.filter((s) => s !== scope)))} />
                        <span>
                          <span className="block font-mono text-[13px]">{scope}</span>
                          <span className="block text-xs text-muted-foreground">{desc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  <Field label="Allowed IP addresses" hint="One IP or CIDR per line. Leave empty to allow any IP.">
                    <Textarea value={ips} onChange={(e) => setIps(e.target.value)} placeholder={'203.0.113.10\n198.51.100.0/24'} className="font-mono text-xs" />
                  </Field>
                  <Field label="Allowed endpoints" hint='One "METHOD /path" pattern per line; * is a wildcard. Leave empty to allow every endpoint covered by the scopes.'>
                    <Textarea value={endpoints} onChange={(e) => setEndpoints(e.target.value)} placeholder={'GET /api/v1/files*\nPOST /api/v1/files'} className="font-mono text-xs" />
                  </Field>
                  <Field label="Rate limit (requests per minute)" hint="Leave empty to use the default from settings.">
                    <Input type="number" min={1} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} className="w-40" />
                  </Field>
                </>
              )}
              {step === 3 && (
                <>
                  <Field label="Expiration">
                    <NativeSelect value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                      <option value="never">Never expires</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">1 year</option>
                      <option value="custom">Custom date…</option>
                    </NativeSelect>
                  </Field>
                  {expiry === 'custom' && (
                    <Field label="Expires at">
                      <Input type="datetime-local" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)} />
                    </Field>
                  )}
                </>
              )}
              {step === 4 && (
                <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd>{name}</dd>
                  <dt className="text-muted-foreground">Environment</dt>
                  <dd>{environment}</dd>
                  <dt className="text-muted-foreground">Scopes</dt>
                  <dd className="font-mono text-xs">{scopes.join(', ')}</dd>
                  <dt className="text-muted-foreground">IP restrictions</dt>
                  <dd>{lines(ips).join(', ') || 'Any IP'}</dd>
                  <dt className="text-muted-foreground">Endpoints</dt>
                  <dd className="font-mono text-xs">{lines(endpoints).join(', ') || 'All allowed by scopes'}</dd>
                  <dt className="text-muted-foreground">Rate limit</dt>
                  <dd>{rateLimit ? `${rateLimit}/min` : 'Default'}</dd>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd>{expiresAt() ? new Date(expiresAt()!).toLocaleString() : 'Never'}</dd>
                </dl>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              {step > 0 && (
                <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={busy}>
                  Back
                </Button>
              )}
              {step < STEPS.length - 1 ? (
                <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
                  Continue
                </Button>
              ) : (
                <Button onClick={generate} loading={busy}>
                  Generate key
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Shows a freshly rotated key once. */
export function RevealKeyDialog({ value, onClose }: { value: string | null; onClose: () => void }) {
  const [ack, setAck] = React.useState(false);
  React.useEffect(() => setAck(false), [value]);
  return (
    <Dialog open={Boolean(value)} onOpenChange={(o) => !o && ack && onClose()}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => !ack && e.preventDefault()}>
        <DialogHeader title="New API key" />
        <DialogBody>
          <div className="flex gap-3 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="font-semibold">IMPORTANT: Copy this API key now.</p>
              <p className="text-muted-foreground">You will not be able to view it again.</p>
            </div>
          </div>
          <code className="block break-all rounded-md border bg-subtle p-2 font-mono text-[13px]">{value}</code>
          {value && (
            <CopyButton value={value} label="API key copied">
              Copy API Key
            </CopyButton>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={ack} onCheckedChange={(c) => setAck(c === true)} /> I have stored this key securely.
          </label>
        </DialogBody>
        <DialogFooter>
          <Button disabled={!ack} onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
