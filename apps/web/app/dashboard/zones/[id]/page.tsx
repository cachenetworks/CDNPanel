'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Globe, Plus, RefreshCw, ShieldCheck, Star, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { VISIBILITIES, type CacheRuleDTO, type DomainDTO, type ReplicationStrategy, type StorageProviderDTO, type UsageMetrics, type ZoneDTO } from '@/lib/types';
import { formatBytes, formatDate, formatNumber, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, NativeSelect, Switch } from '@/components/ui/form';
import { Badge, CopyButton, EmptyState, ErrorState, KeyValue, PageHeader, Panel, Section, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { ListInput, Stat, StatGrid, StatusDot, TTL_PRESETS, formatTtl, healthTone } from '@/components/ui/stat';
import { useConfirm, useStepUp } from '@/components/confirm';

type Patch = Partial<Record<string, unknown>>;

function useZone(id: string) {
  return useQuery({ queryKey: ['zone', id], queryFn: () => api<ZoneDTO>(`/zones/${id}`) });
}

function TtlSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const known = TTL_PRESETS.some((p) => p.value === value);
  return (
    <NativeSelect className="w-full" value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
      {!known && <option value={value}>{formatTtl(value)}</option>}
      {TTL_PRESETS.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex items-center justify-end gap-2 rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur">
      <span className="mr-auto px-2 text-[13px] text-muted-foreground">Unsaved changes</span>
      <Button variant="secondary" size="sm" onClick={onReset}>
        Discard
      </Button>
      <Button size="sm" loading={busy} onClick={onSave}>
        Save changes
      </Button>
    </div>
  );
}

/** Local draft of zone fields with a single PATCH. */
function useZoneDraft(zone: ZoneDTO | undefined) {
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<Patch>({});
  const [busy, setBusy] = React.useState(false);
  const value = <K extends keyof ZoneDTO>(k: K): ZoneDTO[K] => (k in draft ? (draft[k] as ZoneDTO[K]) : zone![k]);
  const set = (k: keyof ZoneDTO, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    if (!zone) return;
    setBusy(true);
    try {
      await api(`/zones/${zone.id}`, { method: 'PATCH', body: draft });
      toast.success('Zone updated');
      setDraft({});
      void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
      void qc.invalidateQueries({ queryKey: ['zones'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { value, set, save, busy, dirty: Object.keys(draft).length > 0, reset: () => setDraft({}) };
}

// ─── Settings ────────────────────────────────────────────────────────────────

function SettingsTab({ zone, providers, editable }: { zone: ZoneDTO; providers: StorageProviderDTO[]; editable: boolean }) {
  const d = useZoneDraft(zone);
  const confirm = useConfirm();
  const router = useRouter();
  return (
    <div className="max-w-3xl">
      <Section title="General">
        <Panel className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={String(d.value('name'))} disabled={!editable} onChange={(e) => d.set('name', e.target.value)} />
            </Field>
            <Field label="Storage for new uploads">
              <NativeSelect className="w-full" disabled={!editable} value={d.value('storage_provider_id') ?? ''} onChange={(e) => d.set('storage_provider_id', e.target.value || null)}>
                <option value="">Global default</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind}{p.region ? ` · ${p.region}` : ''})
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Default visibility for new files">
              <NativeSelect className="w-full" disabled={!editable} value={d.value('default_visibility') ?? ''} onChange={(e) => d.set('default_visibility', e.target.value || null)}>
                <option value="">Folder / global default</option>
                {VISIBILITIES.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Maximum file size" hint="Empty uses the global limit.">
              <Input
                type="number"
                min={1}
                disabled={!editable}
                value={d.value('max_file_size') ? String(Math.round(Number(d.value('max_file_size')) / 1024 ** 2)) : ''}
                onChange={(e) => d.set('max_file_size', e.target.value ? Number(e.target.value) * 1024 ** 2 : null)}
                placeholder="MB"
              />
            </Field>
          </div>
          <Field label="Allowed file types" hint="MIME patterns such as image/*, video/mp4. Empty allows everything the global settings allow.">
            <ListInput value={d.value('allowed_mime_types')} onChange={(v) => d.set('allowed_mime_types', v)} placeholder="image/*, video/mp4" />
          </Field>
          <div className="flex items-center justify-between">
            <div>
              <Label>Zone enabled</Label>
              <p className="text-xs text-muted-foreground">Disabled zones answer 404 on every hostname.</p>
            </div>
            <Switch disabled={!editable} checked={d.value('enabled')} onCheckedChange={(v) => d.set('enabled', v)} />
          </div>
        </Panel>
      </Section>
      <Section title="Details">
        <Panel className="p-4">
          <KeyValue
            items={[
              ['Zone ID', <span key="id" className="flex items-center gap-1 font-mono text-xs">{zone.id}<CopyButton value={zone.id} /></span>],
              ['Project', zone.project?.name ?? zone.project_id],
              ['Root folder', <Link key="f" className="font-mono text-xs hover:underline" href={`/dashboard/files?folder=${zone.root_folder?.id ?? ''}`}>{zone.root_folder?.path ?? '/'}</Link>],
              ['Created', formatDate(zone.created_at)],
            ]}
          />
        </Panel>
      </Section>
      {editable && (
        <Section title="Danger zone">
          <Panel className="flex items-center justify-between gap-4 p-4">
            <p className="text-[13px] text-muted-foreground">Deleting the zone removes its domains and rules. Files and the root folder are kept.</p>
            <Button
              variant="destructive"
              onClick={() =>
                confirm({
                  title: `Delete zone ${zone.name}?`,
                  destructive: true,
                  requireReauth: true,
                  typeToConfirm: zone.slug,
                  confirmLabel: 'Delete zone',
                  successMessage: 'Zone deleted',
                  action: async () => {
                    await api(`/zones/${zone.id}`, { method: 'DELETE' });
                    router.push('/dashboard/zones');
                  },
                })
              }
            >
              <Trash2 /> Delete zone
            </Button>
          </Panel>
        </Section>
      )}
      <SaveBar dirty={d.dirty} busy={d.busy} onSave={d.save} onReset={d.reset} />
    </div>
  );
}

// ─── Domains ─────────────────────────────────────────────────────────────────

interface DnsCheck {
  txt: { name: string; expected: string; found: string[]; ok: boolean };
  routing: { cname: string[]; addresses: string[]; expected_cname: string; ok: boolean };
}

function DnsRecord({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <div className="grid grid-cols-[56px_1fr] gap-x-3 gap-y-1 rounded-md border bg-subtle p-3 text-[13px] sm:grid-cols-[56px_1fr_1fr]">
      <Badge tone="outline" className="h-fit w-fit">
        {type}
      </Badge>
      <div className="flex min-w-0 items-center gap-1">
        <code className="truncate text-xs">{name}</code>
        <CopyButton value={name} label="Name copied" />
      </div>
      <div className="col-start-2 flex min-w-0 items-center gap-1 sm:col-start-3">
        <code className="truncate text-xs">{value}</code>
        <CopyButton value={value} label="Value copied" />
      </div>
    </div>
  );
}

function DomainWizard({ zone, open, onOpenChange }: { zone: ZoneDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [hostname, setHostname] = React.useState('');
  const [domain, setDomain] = React.useState<DomainDTO | null>(null);
  const [dns, setDns] = React.useState<DnsCheck | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setStep(1);
      setHostname('');
      setDomain(null);
      setDns(null);
    }
  }, [open]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
    void qc.invalidateQueries({ queryKey: ['zones'] });
  };
  const verify = async () => {
    if (!domain) return;
    setBusy(true);
    try {
      const r = await api<{ domain: DomainDTO; dns: DnsCheck | null }>(`/domains/${domain.id}/verify`, { method: 'POST' });
      setDomain(r.domain);
      setDns(r.dns);
      refresh();
      if (r.domain.status === 'ACTIVE') setStep(3);
      else toast.error('Not verified yet — DNS changes can take a few minutes to propagate.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="Connect a custom domain" description={`Step ${step} of 3 — ${step === 1 ? 'choose a hostname' : step === 2 ? 'add DNS records' : 'done'}`} />
        <DialogBody>
          <ol className="mb-2 flex gap-2 text-xs">
            {['Hostname', 'DNS records', 'Live'].map((label, i) => (
              <li key={label} className={`flex-1 rounded border px-2 py-1 text-center ${step === i + 1 ? 'border-primary text-foreground' : step > i + 1 ? 'text-[hsl(var(--success))]' : 'text-muted-foreground'}`}>
                {i + 1}. {label}
              </li>
            ))}
          </ol>
          {step === 1 && (
            <form
              id="domain-step-1"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const d = await api<DomainDTO>(`/zones/${zone.id}/domains`, { body: { hostname } });
                  setDomain(d);
                  refresh();
                  setStep(2);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Hostname" hint="A subdomain you control, e.g. assets.example.com. Files are served from the zone root: https://assets.example.com/logo.png">
                <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="assets.example.com" required autoFocus />
              </Field>
            </form>
          )}
          {step === 2 && domain && (
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[13px] font-medium">1. Prove ownership</p>
                <DnsRecord type="TXT" name={domain.verification.txt.name} value={domain.verification.txt.value} />
              </div>
              <div>
                <p className="mb-2 text-[13px] font-medium">2. Route traffic to this server — one of:</p>
                <DnsRecord type="CNAME" name={domain.hostname} value={domain.verification.cname.target} />
                <p className="mt-2 text-xs text-muted-foreground">
                  Using a Cloudflare Tunnel? Add a <strong>public hostname</strong> <code>{domain.hostname}</code> in the tunnel pointing at the same service as your dashboard (e.g. <code>http://nginx:8080</code>) instead of the CNAME. Cloudflare issues the TLS certificate automatically.
                </p>
              </div>
              {dns && (
                <Panel className="space-y-1 p-3 text-[13px]">
                  <StatusDot status={dns.txt.ok ? 'ok' : 'fail'} label={dns.txt.ok ? 'TXT record found' : `TXT record not found yet (saw: ${dns.txt.found.join(', ') || 'nothing'})`} />
                  <StatusDot status={dns.routing.ok ? 'ok' : 'warn'} label={dns.routing.ok ? `Hostname resolves (${[...dns.routing.cname, ...dns.routing.addresses].slice(0, 3).join(', ')})` : 'Hostname does not resolve yet'} />
                </Panel>
              )}
              <p className="text-xs text-muted-foreground">Verification is retried automatically every few minutes for 7 days — you can close this dialog.</p>
            </div>
          )}
          {step === 3 && domain && (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-[hsl(var(--success))]" />
              <p className="font-medium">{domain.hostname} is verified</p>
              <div className="flex justify-center gap-4">
                <StatusDot status={healthTone(domain.tls_status)} label={`TLS ${domain.tls_status}`} />
                <StatusDot status={healthTone(domain.health_status)} label={`Edge ${domain.health_status}`} />
              </div>
              {domain.last_error && <p className="text-xs text-muted-foreground">{domain.last_error}</p>}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {step === 1 && (
            <Button type="submit" form="domain-step-1" loading={busy}>
              Continue
            </Button>
          )}
          {step === 2 && (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Finish later
              </Button>
              <Button loading={busy} onClick={verify}>
                <ShieldCheck /> Verify now
              </Button>
            </>
          )}
          {step === 3 && <Button onClick={() => onOpenChange(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DomainsTab({ zone, editable }: { zone: ZoneDTO; editable: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [wizard, setWizard] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const domains = zone.domains ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
  const run = async (id: string, path: string, label: string) => {
    setBusy(id);
    try {
      const r = await api<{ domain: DomainDTO }>(`/domains/${id}/${path}`, { method: 'POST' });
      toast[r.domain.status === 'ACTIVE' && r.domain.health_status !== 'unhealthy' ? 'success' : 'message'](`${label}: ${r.domain.status.toLowerCase()}${r.domain.last_error ? ` — ${r.domain.last_error}` : ''}`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Section
        title="Custom domains"
        description="Verified hostnames serve this zone’s files at zone-relative paths. They also answer /files, /img, /media and /s URLs — but only for this zone."
        actions={
          editable && (
            <Button size="sm" onClick={() => setWizard(true)}>
              <Plus /> Add domain
            </Button>
          )
        }
      >
        <Panel>
          {domains.length === 0 ? (
            <EmptyState icon={Globe} title="No custom domains" description="Files are still reachable on the platform CDN hostname." action={editable && <Button size="sm" onClick={() => setWizard(true)}>Connect a domain</Button>} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Hostname</TH>
                  <TH>Status</TH>
                  <TH>TLS</TH>
                  <TH>Edge health</TH>
                  <TH>Last check</TH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <tbody>
                {domains.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <div className="flex items-center gap-1.5 font-mono text-xs">
                        {d.is_primary && <Star className="h-3.5 w-3.5 fill-current text-[hsl(var(--warning))]" aria-label="Primary domain" />}
                        {d.hostname}
                      </div>
                      {d.last_error && <div className="mt-0.5 max-w-sm truncate text-[11px] text-muted-foreground" title={d.last_error}>{d.last_error}</div>}
                    </TD>
                    <TD>
                      <Badge tone={d.status === 'ACTIVE' ? 'success' : d.status === 'PENDING' ? 'warning' : 'danger'}>{d.status}</Badge>
                    </TD>
                    <TD>
                      <StatusDot status={healthTone(d.tls_status)} label={d.tls_status} />
                    </TD>
                    <TD>
                      <StatusDot status={healthTone(d.health_status)} label={d.health_status} />
                    </TD>
                    <TD className="text-xs text-muted-foreground">{timeAgo(d.last_checked_at)}</TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        {d.status !== 'ACTIVE' && editable && (
                          <Button size="xs" variant="secondary" loading={busy === d.id} onClick={() => run(d.id, 'verify', 'Verification')}>
                            Verify
                          </Button>
                        )}
                        {d.status === 'ACTIVE' && (
                          <Button size="xs" variant="secondary" loading={busy === d.id} onClick={() => run(d.id, 'check', 'Health check')}>
                            <RefreshCw /> Check
                          </Button>
                        )}
                        {editable && d.status === 'ACTIVE' && !d.is_primary && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={async () => {
                              await api(`/domains/${d.id}`, { method: 'PATCH', body: { is_primary: true } }).catch((e) => toast.error(errorMessage(e)));
                              refresh();
                            }}
                          >
                            Make primary
                          </Button>
                        )}
                        {editable && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive"
                            aria-label={`Remove ${d.hostname}`}
                            onClick={() =>
                              confirm({
                                title: `Remove ${d.hostname}?`,
                                description: 'The hostname stops serving this zone immediately.',
                                destructive: true,
                                confirmLabel: 'Remove domain',
                                successMessage: 'Domain removed',
                                action: async () => {
                                  await api(`/domains/${d.id}`, { method: 'DELETE' });
                                  refresh();
                                },
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        {domains.some((d) => d.status !== 'ACTIVE') && (
          <div className="mt-3 space-y-2">
            {domains
              .filter((d) => d.status !== 'ACTIVE')
              .map((d) => (
                <Panel key={d.id} className="space-y-2 p-3">
                  <p className="text-[13px] font-medium">DNS records for {d.hostname}</p>
                  <DnsRecord type="TXT" name={d.verification.txt.name} value={d.verification.txt.value} />
                  <DnsRecord type="CNAME" name={d.hostname} value={d.verification.cname.target} />
                </Panel>
              ))}
          </div>
        )}
      </Section>
      <DomainWizard zone={zone} open={wizard} onOpenChange={setWizard} />
    </>
  );
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function RuleDialog({ zone, rule, open, onOpenChange }: { zone: ZoneDTO; rule: CacheRuleDTO | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const [edge, setEdge] = React.useState<string>('');
  const [browser, setBrowser] = React.useState<string>('');
  const [bypass, setBypass] = React.useState(false);
  const [priority, setPriority] = React.useState('100');
  React.useEffect(() => {
    if (open) {
      setName(rule?.name ?? '');
      setPattern(rule?.pattern ?? '');
      setEdge(rule?.edge_ttl === null || rule?.edge_ttl === undefined ? '' : String(rule.edge_ttl));
      setBrowser(rule?.browser_ttl === null || rule?.browser_ttl === undefined ? '' : String(rule.browser_ttl));
      setBypass(rule?.bypass ?? false);
      setPriority(String(rule?.priority ?? 100));
    }
  }, [open, rule]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={rule ? 'Edit cache rule' : 'New cache rule'} description="Zone-relative globs: * within a segment, ** across segments. Patterns without / match the file name (*.css)." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const body = { name, pattern, edge_ttl: edge === '' ? null : Number(edge), browser_ttl: browser === '' ? null : Number(browser), bypass, priority: Number(priority) };
            try {
              if (rule) await api(`/cache-rules/${rule.id}`, { method: 'PATCH', body });
              else await api(`/zones/${zone.id}/cache-rules`, { body });
              toast.success('Cache rule saved');
              void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Pattern">
                <Input value={pattern} onChange={(e) => setPattern(e.target.value)} required placeholder="/releases/** or *.js" className="font-mono" />
              </Field>
              <Field label="Edge TTL" hint="Empty inherits the zone value.">
                <NativeSelect className="w-full" value={edge} disabled={bypass} onChange={(e) => setEdge(e.target.value)}>
                  <option value="">Inherit ({formatTtl(zone.edge_ttl)})</option>
                  {TTL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Browser TTL">
                <NativeSelect className="w-full" value={browser} disabled={bypass} onChange={(e) => setBrowser(e.target.value)}>
                  <option value="">Inherit ({formatTtl(zone.browser_ttl)})</option>
                  {TTL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Priority" hint="Lower runs first.">
                <Input type="number" min={0} max={10000} value={priority} onChange={(e) => setPriority(e.target.value)} />
              </Field>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Bypass the edge cache</Label>
                <p className="text-xs text-muted-foreground">Responses are revalidated by browsers and never stored at the edge.</p>
              </div>
              <Switch checked={bypass} onCheckedChange={setBypass} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save rule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CacheTab({ zone, editable }: { zone: ZoneDTO; editable: boolean }) {
  const d = useZoneDraft(zone);
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const { can } = useSession();
  const [ruleDialog, setRuleDialog] = React.useState<{ open: boolean; rule: CacheRuleDTO | null }>({ open: false, rule: null });
  const [cfZone, setCfZone] = React.useState(zone.cloudflare.zone_id ?? '');
  const [cfToken, setCfToken] = React.useState('');
  return (
    <div className="max-w-4xl">
      <Section title="Default TTLs" description="Browsers get Cache-Control: max-age=<browser TTL>; CDNs get CDN-Cache-Control: max-age=<edge TTL>. A long edge TTL with automatic purges gives the best hit ratio.">
        <Panel className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Edge TTL">
            <TtlSelect value={Number(d.value('edge_ttl'))} onChange={(v) => d.set('edge_ttl', v)} />
          </Field>
          <Field label="Browser TTL">
            <TtlSelect value={Number(d.value('browser_ttl'))} onChange={(v) => d.set('browser_ttl', v)} />
          </Field>
        </Panel>
      </Section>
      <Section
        title="Cache rules"
        actions={
          editable && (
            <Button size="sm" onClick={() => setRuleDialog({ open: true, rule: null })}>
              <Plus /> Add rule
            </Button>
          )
        }
      >
        <Panel>
          {(zone.cache_rules ?? []).length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No rules — every file uses the zone TTLs.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH className="w-16">Priority</TH>
                  <TH>Name</TH>
                  <TH>Pattern</TH>
                  <TH>Edge</TH>
                  <TH>Browser</TH>
                  <TH className="w-24" />
                </tr>
              </THead>
              <tbody>
                {zone.cache_rules!.map((r) => (
                  <TR key={r.id}>
                    <TD className="tabular text-muted-foreground">{r.priority}</TD>
                    <TD>
                      {r.name} {!r.enabled && <Badge>Off</Badge>}
                    </TD>
                    <TD className="font-mono text-xs">{r.pattern}</TD>
                    <TD className="text-xs">{r.bypass ? <Badge tone="warning">Bypass</Badge> : r.edge_ttl === null ? 'inherit' : formatTtl(r.edge_ttl)}</TD>
                    <TD className="text-xs">{r.bypass ? '—' : r.browser_ttl === null ? 'inherit' : formatTtl(r.browser_ttl)}</TD>
                    <TD>
                      {editable && (
                        <div className="flex justify-end gap-1">
                          <Button size="xs" variant="ghost" onClick={() => setRuleDialog({ open: true, rule: r })}>
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive"
                            aria-label="Delete rule"
                            onClick={async () => {
                              await api(`/cache-rules/${r.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                              void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </Section>
      <Section title="Cloudflare" description="With an API token (Zone → Cache Purge, Zone → Analytics: Read) purges reach the edge and the Cache page shows real HIT / MISS statistics.">
        <Panel className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cloudflare zone ID">
              <Input value={cfZone} disabled={!editable} onChange={(e) => setCfZone(e.target.value)} placeholder="32 hex characters" className="font-mono" />
            </Field>
            <Field label="API token" hint={zone.cloudflare.token_configured ? 'A token is stored. Enter a new one to replace it.' : 'Stored encrypted; never shown again.'}>
              <Input type="password" value={cfToken} disabled={!editable} onChange={(e) => setCfToken(e.target.value)} autoComplete="off" />
            </Field>
          </div>
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  stepUp(
                    async () => {
                      await api(`/zones/${zone.id}/cloudflare`, { method: 'PUT', body: { cloudflare_zone_id: cfZone || null, ...(cfToken ? { api_token: cfToken } : {}) } });
                      setCfToken('');
                      void qc.invalidateQueries({ queryKey: ['zone', zone.id] });
                    },
                    { title: 'Save Cloudflare credentials', successMessage: 'Cloudflare settings saved' },
                  )
                }
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const r = await api<{ ok: boolean; zone?: { name: string; status: string }; error?: string }>(`/zones/${zone.id}/cloudflare/test`, { method: 'POST' });
                  if (r.ok) toast.success(`Connected to ${r.zone!.name} (${r.zone!.status})`);
                  else toast.error(r.error ?? 'Connection failed');
                }}
              >
                Test connection
              </Button>
              {can('cache.purge') && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await api('/cache/purge', { body: { type: 'zone', targets: [zone.id], zone_id: zone.id } });
                      toast.success('Zone purge queued');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <Zap /> Purge whole zone
                </Button>
              )}
            </div>
          )}
        </Panel>
      </Section>
      <RuleDialog zone={zone} rule={ruleDialog.rule} open={ruleDialog.open} onOpenChange={(o) => setRuleDialog((s) => ({ ...s, open: o }))} />
      <SaveBar dirty={d.dirty} busy={d.busy} onSave={d.save} onReset={d.reset} />
    </div>
  );
}

// ─── Security ────────────────────────────────────────────────────────────────

function SecurityTab({ zone, editable }: { zone: ZoneDTO; editable: boolean }) {
  const d = useZoneDraft(zone);
  return (
    <div className="max-w-3xl">
      <Section title="Hotlink protection" description="Only listed sites may embed or link to this zone’s files. The zone’s own domains and the dashboard are always allowed.">
        <Panel className="space-y-4 p-4">
          <Field label="Allowed referrers" hint="Hostnames, with *.example.com wildcards. Empty disables hotlink protection.">
            <ListInput value={d.value('allowed_referrers')} onChange={(v) => d.set('allowed_referrers', v)} placeholder="example.com, *.example.com" />
          </Field>
          <div className="flex items-center justify-between">
            <div>
              <Label>Allow requests without a Referer</Label>
              <p className="text-xs text-muted-foreground">Direct visits, apps and privacy-focused browsers often send no Referer.</p>
            </div>
            <Switch disabled={!editable} checked={d.value('allow_empty_referrer')} onCheckedChange={(v) => d.set('allow_empty_referrer', v)} />
          </div>
        </Panel>
      </Section>
      <Section title="Geo restrictions" description="Countries come from Cloudflare (CF-IPCountry); requests with unknown country are allowed.">
        <Panel className="space-y-4 p-4">
          <Field label="Allow only these countries" hint="ISO codes, e.g. AU, NZ. Empty allows every country.">
            <ListInput upper value={d.value('allowed_countries')} onChange={(v) => d.set('allowed_countries', v)} placeholder="AU, NZ" />
          </Field>
          <Field label="Block these countries">
            <ListInput upper value={d.value('blocked_countries')} onChange={(v) => d.set('blocked_countries', v)} placeholder="KP" />
          </Field>
          <Field label="Block these networks (ASNs)" hint="Needs ASN_HEADER configured (e.g. a Cloudflare transform rule adding the client ASN).">
            <ListInput
              value={(d.value('blocked_asns') as number[]).map(String)}
              onChange={(v) => d.set('blocked_asns', v.map((x) => Number(x.replace(/^AS/i, ''))).filter((n) => Number.isInteger(n) && n > 0))}
              placeholder="AS14061, 16509"
            />
          </Field>
        </Panel>
      </Section>
      <Panel className="flex items-center justify-between gap-3 p-4">
        <p className="text-[13px] text-muted-foreground">WAF rules (rate-based blocks, challenges, bans) for this zone are managed on the Security page.</p>
        <Button size="sm" variant="secondary" asChild>
          <Link href={`/dashboard/security?tab=rules&zone=${zone.id}`}>Security rules</Link>
        </Button>
      </Panel>
      <SaveBar dirty={d.dirty} busy={d.busy} onSave={d.save} onReset={d.reset} />
    </div>
  );
}

// ─── Images & media ──────────────────────────────────────────────────────────

function MediaTab({ zone, editable }: { zone: ZoneDTO; editable: boolean }) {
  const d = useZoneDraft(zone);
  const row = (label: string, hint: string, key: 'image_optimization' | 'require_signed_transforms' | 'video_processing') => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch disabled={!editable} checked={Boolean(d.value(key))} onCheckedChange={(v) => d.set(key, v)} />
    </div>
  );
  const example = zone.domains?.find((x) => x.is_primary && x.status === 'ACTIVE')?.hostname;
  return (
    <div className="max-w-3xl">
      <Section title="Image optimisation">
        <Panel className="space-y-4 p-4">
          {row('Enable /img/ transformations', 'Resize, crop, convert (WebP / AVIF), compress, rotate, blur, sharpen and watermark on the fly. Variants are cached permanently.', 'image_optimization')}
          {row('Require signed transformation URLs', 'Strongly recommended: stops anyone from generating unlimited variants of your images.', 'require_signed_transforms')}
          <pre className="overflow-x-auto rounded-md bg-subtle p-3 text-xs">{`https://${example ?? 'cdn.example.com'}/img/<file id>?w=800&h=600&fit=cover&format=auto&q=80&s=<signature>`}</pre>
          <p className="text-xs text-muted-foreground">Create signed URLs from a file’s “Image” tab or with POST /api/v1/images/sign.</p>
        </Panel>
      </Section>
      <Section title="Video & audio">
        <Panel className="space-y-4 p-4">
          {row('Process uploads with FFmpeg', 'Thumbnails, previews, MP4 / WebM, HLS / DASH streaming, audio extraction and waveforms — renditions are configured in Settings → Video & audio.', 'video_processing')}
        </Panel>
      </Section>
      <SaveBar dirty={d.dirty} busy={d.busy} onSave={d.save} onReset={d.reset} />
    </div>
  );
}

// ─── Replication ─────────────────────────────────────────────────────────────

interface ReplicationStatus {
  strategy: ReplicationStrategy;
  providers: { id: string; name: string; kind: string; region: string; health: string; latency_ms: number | null; role: string; replicas: Record<string, { count: number; bytes: number }> }[];
}

const STRATEGIES: { value: ReplicationStrategy; label: string; description: string }[] = [
  { value: 'PRIMARY_ONLY', label: 'Primary only', description: 'Always serve from the primary provider. Replicas are backups.' },
  { value: 'MIRROR', label: 'Mirror', description: 'Serve from the primary; fall back to a replica if a read fails.' },
  { value: 'FAILOVER', label: 'Failover', description: 'Skip providers marked unhealthy by the health checks, then fall back on read errors.' },
  { value: 'NEAREST', label: 'Nearest', description: 'Serve from the healthy copy whose provider serves the visitor’s country (Storage → served countries).' },
];

function ReplicationTab({ zone, providers, editable }: { zone: ZoneDTO; providers: StorageProviderDTO[]; editable: boolean }) {
  const d = useZoneDraft(zone);
  const status = useQuery({ queryKey: ['zone', zone.id, 'replication'], queryFn: () => api<ReplicationStatus>(`/zones/${zone.id}/replication`), refetchInterval: 15_000 });
  const replicaIds = d.value('replica_provider_ids') as string[];
  const primaryId = zone.storage_provider_id ?? providers.find((p) => p.is_default)?.id;
  return (
    <div className="max-w-4xl">
      <Section title="Strategy">
        <Panel className="grid gap-2 p-4 sm:grid-cols-2">
          {STRATEGIES.map((s) => (
            <label key={s.value} className={`cursor-pointer rounded-md border p-3 ${d.value('replication_strategy') === s.value ? 'border-primary bg-[hsl(var(--primary)/0.05)]' : ''}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="strategy" disabled={!editable} checked={d.value('replication_strategy') === s.value} onChange={() => d.set('replication_strategy', s.value)} />
                <span className="text-[13px] font-medium">{s.label}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
            </label>
          ))}
        </Panel>
      </Section>
      <Section title="Replica providers" description="Every file in the zone is copied to these providers in the background, verified, and repaired if a copy goes missing.">
        <Panel className="divide-y">
          {providers
            .filter((p) => p.id !== primaryId)
            .map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={replicaIds.includes(p.id)}
                  onChange={(e) => d.set('replica_provider_ids', e.target.checked ? [...replicaIds, p.id] : replicaIds.filter((x) => x !== p.id))}
                />
                <span className="flex-1 text-[13px]">
                  {p.name} <span className="text-muted-foreground">· {p.kind}{p.region ? ` · ${p.region}` : ''}</span>
                </span>
                <StatusDot status={healthTone(p.health_status)} label={p.latency_ms !== null ? `${p.latency_ms} ms` : p.health_status} />
              </label>
            ))}
          {providers.length <= 1 && <p className="px-4 py-4 text-[13px] text-muted-foreground">Add another storage provider (Storage page) to replicate to it.</p>}
        </Panel>
      </Section>
      <Section
        title="Status"
        actions={
          editable && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const r = await api<{ queued: number }>(`/zones/${zone.id}/replicate`, { method: 'POST' });
                toast.success(`${r.queued} replication job(s) queued`);
                void status.refetch();
              }}
            >
              <RefreshCw /> Replicate now
            </Button>
          )
        }
      >
        <Panel>
          {!status.data ? (
            <Skeleton className="m-3 h-20" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Provider</TH>
                  <TH>Role</TH>
                  <TH>Health</TH>
                  <TH className="text-right">Synced</TH>
                  <TH className="text-right">Pending</TH>
                  <TH className="text-right">Failed / missing</TH>
                </tr>
              </THead>
              <tbody>
                {status.data.providers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      {p.name} <span className="text-xs text-muted-foreground">{p.region}</span>
                    </TD>
                    <TD>
                      <Badge tone={p.role === 'primary' ? 'info' : 'neutral'}>{p.role}</Badge>
                    </TD>
                    <TD>
                      <StatusDot status={healthTone(p.health)} label={p.latency_ms !== null ? `${p.health} · ${p.latency_ms} ms` : p.health} />
                    </TD>
                    <TD className="text-right tabular">{formatNumber(p.replicas.SYNCED?.count ?? 0)}</TD>
                    <TD className="text-right tabular">{formatNumber(p.replicas.PENDING?.count ?? 0)}</TD>
                    <TD className="text-right tabular">{formatNumber((p.replicas.FAILED?.count ?? 0) + (p.replicas.MISSING?.count ?? 0))}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </Section>
      <SaveBar dirty={d.dirty} busy={d.busy} onSave={d.save} onReset={d.reset} />
    </div>
  );
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function UsageTab({ zone }: { zone: ZoneDTO }) {
  const q = useQuery({ queryKey: ['usage', 'zone', zone.id], queryFn: () => api<{ usage: UsageMetrics; cost: { currency: string; total: number }; period_start: string }>('/usage', { query: { scope_type: 'zone', scope_id: zone.id } }) });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-24" />;
  const u = q.data.usage;
  return (
    <>
      <p className="mb-3 text-[13px] text-muted-foreground">Month to date since {formatDate(q.data.period_start, false)}.</p>
      <StatGrid>
        <Stat label="Storage" value={formatBytes(u.storage_bytes)} />
        <Stat label="Egress" value={formatBytes(u.egress_bytes)} />
        <Stat label="Requests" value={formatNumber(u.requests)} />
        <Stat label="Transforms" value={formatNumber(u.transforms)} sub={`${Math.round(u.cpu_ms / 1000)} CPU s`} />
        <Stat label="Uploaded" value={formatBytes(u.upload_bytes)} />
        <Stat label="Estimated cost" value={`${q.data.cost.total.toFixed(2)} ${q.data.cost.currency}`} />
      </StatGrid>
      <p className="mt-3 text-[13px]">
        <Link href="/dashboard/usage" className="text-primary hover:underline">
          Quotas and cost breakdown →
        </Link>
      </p>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function ZoneDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useSession();
  const q = useZone(id);
  const providers = useQuery({ queryKey: ['storage'], queryFn: () => api<{ providers: StorageProviderDTO[] }>('/storage'), enabled: can('files.view') });
  const tab = params.get('tab') ?? 'settings';
  const editable = can('zones.manage');
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const zone = q.data;
  const list = providers.data?.providers ?? [];
  return (
    <>
      <Link href="/dashboard/zones" className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Zones
      </Link>
      <PageHeader
        title={zone.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{zone.project?.name}</span>·<code className="text-xs">{zone.root_folder?.path ?? '/'}</code>
            {!zone.enabled && <Badge tone="warning">Disabled</Badge>}
          </span>
        }
      />
      <Tabs value={tab} onValueChange={(v) => router.replace(`/dashboard/zones/${id}?tab=${v}`)}>
        <TabsList className="mb-5 overflow-x-auto">
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="domains">Domains ({zone.domains?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="cache">Cache</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="media">Images & video</TabsTrigger>
          <TabsTrigger value="replication">Replication</TabsTrigger>
          {can('usage.view') && <TabsTrigger value="usage">Usage</TabsTrigger>}
        </TabsList>
        <TabsContent value="settings">
          <SettingsTab zone={zone} providers={list} editable={editable} />
        </TabsContent>
        <TabsContent value="domains">
          <DomainsTab zone={zone} editable={editable} />
        </TabsContent>
        <TabsContent value="cache">
          <CacheTab zone={zone} editable={editable} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab zone={zone} editable={editable} />
        </TabsContent>
        <TabsContent value="media">
          <MediaTab zone={zone} editable={editable} />
        </TabsContent>
        <TabsContent value="replication">
          <ReplicationTab zone={zone} providers={list} editable={editable} />
        </TabsContent>
        {can('usage.view') && (
          <TabsContent value="usage">
            <UsageTab zone={zone} />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

export default function ZonePage() {
  return (
    <React.Suspense fallback={<Skeleton className="h-96" />}>
      <ZoneDetail />
    </React.Suspense>
  );
}
