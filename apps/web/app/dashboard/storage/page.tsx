'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FileDTO } from '@/lib/types';
import { formatBytes, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Switch, Label } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { RankedBars } from '@/components/charts';
import { useConfirm, useStepUp } from '@/components/confirm';
import { ListInput, StatusDot, healthTone } from '@/components/ui/stat';

interface Provider {
  id: string;
  name: string;
  kind: 'LOCAL' | 'S3' | 'R2' | 'MINIO' | 'B2' | 'POOL';
  is_default: boolean;
  enabled: boolean;
  public_info: Record<string, string>;
  capacity: number | null;
  configured_capacity: number | null;
  available: number | null;
  disk_total: number | null;
  disk_free: number | null;
  disk_used: number | null;
  disk_other_used_estimate: number | null;
  used: number;
  file_count: number;
  region: string;
  serves_countries: string[];
  priority: number;
  cost_storage_per_gb_month: number;
  cost_egress_per_gb: number;
  cost_per_million_requests: number;
  health_status: string;
  bucket_used: number | null;
  bucket_objects: number | null;
  bucket_usage_partial: boolean;
  usage_checked_at: string | null;
  latency_ms: number | null;
}
interface StorageStats {
  used: number;
  quota: number | null;
  available: number | null;
  capacity: number | null;
  disk_total: number | null;
  disk_free: number | null;
  disk_used: number | null;
  disk_other_used_estimate: number | null;
  file_count: number;
  average_file_size: number;
  largest_files: FileDTO[];
  by_type: { type: string; count: number; bytes: number }[];
  providers: Provider[];
  default_backend: { id: string; name: string; kind: string } | null;
  cluster: {
    total: number;
    free: number;
    used: number;
    online_servers: number;
    server_count: number;
    cloud_count: number;
    servers: { name: string; role: 'main' | 'node' | 'cloud'; kind?: string; status: string; total: number | null; free: number | null; used: number | null; objects?: number | null; checked_at?: string | null; partial?: boolean }[];
  };
}

const KIND_HINTS: Record<Provider['kind'], string> = {
  POOL: 'A RAID pool of storage nodes, managed under Nodes & RAID.',
  LOCAL: 'A directory on the server (inside the allowed base directory).',
  S3: 'Amazon S3. Leave the endpoint empty for AWS.',
  R2: 'Cloudflare R2: endpoint https://<account>.r2.cloudflarestorage.com, region "auto".',
  MINIO: 'MinIO: e.g. http://minio:9000 with path-style addressing.',
  B2: 'Backblaze B2 S3 API: endpoint https://s3.<region>.backblazeb2.com.',
};

function ProviderDialog({ provider, open, onOpenChange }: { provider: Provider | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Provider['kind']>('S3');
  const [root, setRoot] = React.useState('');
  const [endpoint, setEndpoint] = React.useState('');
  const [region, setRegion] = React.useState('auto');
  const [bucket, setBucket] = React.useState('');
  const [accessKeyId, setAccessKeyId] = React.useState('');
  const [secretAccessKey, setSecretAccessKey] = React.useState('');
  const [prefix, setPrefix] = React.useState('');
  const [pathStyle, setPathStyle] = React.useState(false);
  const [capacityGb, setCapacityGb] = React.useState('');
  const [replaceConfig, setReplaceConfig] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [regionLabel, setRegion2] = React.useState('');
  const [serves, setServes] = React.useState<string[]>([]);
  const [priority, setPriority] = React.useState('100');
  const [costStorage, setCostStorage] = React.useState('0');
  const [costEgress, setCostEgress] = React.useState('0');
  const [costRequests, setCostRequests] = React.useState('0');

  React.useEffect(() => {
    if (open) {
      setName(provider?.name ?? '');
      setKind(provider?.kind ?? 'S3');
      setRoot(provider?.public_info.root ?? '');
      setEndpoint(provider?.public_info.endpoint ?? '');
      setRegion(provider?.public_info.region ?? 'auto');
      setBucket(provider?.public_info.bucket ?? '');
      setAccessKeyId('');
      setSecretAccessKey('');
      setPrefix('');
      setPathStyle(false);
      setCapacityGb(provider?.configured_capacity ? String(Math.round(provider.configured_capacity / 1024 ** 3)) : '');
      setReplaceConfig(!provider);
      setRegion2(provider?.region ?? '');
      setServes(provider?.serves_countries ?? []);
      setPriority(String(provider?.priority ?? 100));
      setCostStorage(String(provider?.cost_storage_per_gb_month ?? 0));
      setCostEgress(String(provider?.cost_egress_per_gb ?? 0));
      setCostRequests(String(provider?.cost_per_million_requests ?? 0));
    }
  }, [open, provider]);
  const placement = {
    region: regionLabel.trim(),
    serves_countries: serves,
    priority: Number(priority) || 0,
    cost_storage_per_gb_month: Number(costStorage) || 0,
    cost_egress_per_gb: Number(costEgress) || 0,
    cost_per_million_requests: Number(costRequests) || 0,
  };

  const config = kind === 'LOCAL' ? { kind, root } : { kind, endpoint: endpoint || undefined, region, bucket, accessKeyId, secretAccessKey, forcePathStyle: pathStyle, prefix: prefix || undefined };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={provider ? `Edit ${provider.name}` : 'Add storage provider'} description="Credentials are tested before saving and stored encrypted with AES-256-GCM. They are never shown again." />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void stepUp(
              async () => {
                try {
                  const capacity = capacityGb ? Number(capacityGb) * 1024 ** 3 : null;
                  if (provider) await api(`/storage/providers/${provider.id}`, { method: 'PATCH', body: { name, capacity, ...placement, ...(replaceConfig ? { config } : {}) } });
                  else await api('/storage/providers', { body: { name, capacity, config, ...placement } });
                  void qc.invalidateQueries({ queryKey: ['storage'] });
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              },
              { title: 'Confirm storage change', successMessage: 'Storage provider saved' },
            ).finally(() => setBusy(false));
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Type">
                <NativeSelect className="w-full" value={kind} disabled={Boolean(provider)} onChange={(e) => setKind(e.target.value as Provider['kind'])}>
                  <option value="LOCAL">Local filesystem</option>
                  <option value="S3">AWS S3</option>
                  <option value="R2">Cloudflare R2</option>
                  <option value="MINIO">MinIO</option>
                  <option value="B2">Backblaze B2</option>
                </NativeSelect>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{KIND_HINTS[kind]}</p>
            {provider && (
              <div className="flex items-center justify-between">
                <Label>Replace connection settings</Label>
                <Switch checked={replaceConfig} onCheckedChange={setReplaceConfig} />
              </div>
            )}
            {replaceConfig &&
              (kind === 'LOCAL' ? (
                <Field label="Directory" hint="Relative paths are resolved inside the allowed base directory.">
                  <Input value={root} onChange={(e) => setRoot(e.target.value)} required placeholder="archive-volume" />
                </Field>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Endpoint">
                    <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" />
                  </Field>
                  <Field label="Region">
                    <Input value={region} onChange={(e) => setRegion(e.target.value)} />
                  </Field>
                  <Field label="Bucket">
                    <Input value={bucket} onChange={(e) => setBucket(e.target.value)} required />
                  </Field>
                  <Field label="Key prefix (optional)">
                    <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="cdn" />
                  </Field>
                  <Field label="Access key ID">
                    <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} required autoComplete="off" />
                  </Field>
                  <Field label="Secret access key">
                    <Input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} required autoComplete="new-password" />
                  </Field>
                  <div className="flex items-center gap-2">
                    <Switch checked={pathStyle} onCheckedChange={setPathStyle} id="ps" />
                    <Label htmlFor="ps">Path-style addressing</Label>
                  </div>
                </div>
              ))}
            <Field label="Provider quota (GB, optional)" hint="Limits CDN usage on this provider. Host free space is checked separately where supported; cloud capacity can be unknown. Global upload quotas are in Settings → Uploads.">
              <Input type="number" min={1} value={capacityGb} onChange={(e) => setCapacityGb(e.target.value)} className="w-40" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Region label">
                <Input value={regionLabel} onChange={(e) => setRegion2(e.target.value)} placeholder="au-hobart" />
              </Field>
              <Field label="Serves countries" hint="Used by the NEAREST strategy and the delivery map.">
                <ListInput upper value={serves} onChange={setServes} placeholder="AU, NZ" />
              </Field>
              <Field label="Priority" hint="Lower is preferred.">
                <Input type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />
              </Field>
              <Field label="Storage price / GB-month">
                <Input type="number" min={0} step="0.0001" value={costStorage} onChange={(e) => setCostStorage(e.target.value)} />
              </Field>
              <Field label="Egress price / GB">
                <Input type="number" min={0} step="0.0001" value={costEgress} onChange={(e) => setCostEgress(e.target.value)} />
              </Field>
              <Field label="Price / million requests">
                <Input type="number" min={0} step="0.0001" value={costRequests} onChange={(e) => setCostRequests(e.target.value)} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Test & save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function StoragePage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [dialog, setDialog] = React.useState<{ open: boolean; provider: Provider | null }>({ open: false, provider: null });
  const q = useQuery({ queryKey: ['storage'], queryFn: () => api<StorageStats>('/storage') });
  const d = q.data;
  const manage = can('storage.manage');
  const usedPct = d?.capacity ? Math.min(100, (d.used / d.capacity) * 100) : null;

  return (
    <>
      <PageHeader
        title="Storage"
        description="Usage and storage backends. New uploads go to the default provider; existing files stay where they were stored."
        actions={
          manage && (
            <Button onClick={() => setDialog({ open: true, provider: null })}>
              <Plus /> Add provider
            </Button>
          )
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {!d ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 divide-x divide-y rounded-lg border md:grid-cols-5">
            {[
              ['Storage used', formatBytes(d.used)],
              ['Upload headroom', d.available !== null ? formatBytes(d.available) : 'Unknown'],
              ['Files', formatNumber(d.file_count)],
              ['Average file size', formatBytes(d.average_file_size)],
              ['Default backend', d.default_backend ? `${d.default_backend.name} (${d.default_backend.kind})` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="px-4 py-3">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="mt-1 truncate text-lg font-semibold tabular">{v}</div>
              </div>
            ))}
          </div>
          {d.cluster.servers.length > 1 && (
            <Panel className="mb-8 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{d.cluster.cloud_count ? 'Combined storage across servers and cloud' : 'Combined storage across all servers'}</h3>
                <span className="text-sm tabular">
                  <span className="font-semibold">{formatBytes(d.cluster.total)}</span> total · {formatBytes(d.cluster.used)} used · {formatBytes(d.cluster.free)} free
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                This server&apos;s disk plus every storage node{d.cluster.cloud_count ? ' and cloud bucket' : ''} ({d.cluster.online_servers} of {d.cluster.servers.length} online). Disks are raw space (how much files can use depends on each pool&apos;s RAID level); cloud buckets count their configured quota, with usage measured from the bucket every 30 minutes — see{' '}
                <Link href="/dashboard/nodes" className="underline">
                  Nodes &amp; RAID
                </Link>
                .
              </p>
              <div className="mt-3 space-y-2">
                {d.cluster.servers.map((srv) => {
                  const pct = srv.total && srv.used !== null ? Math.min(100, (srv.used / srv.total) * 100) : 0;
                  return (
                    <div key={srv.name} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                      <StatusDot
                        status={srv.status === 'online' ? 'ok' : srv.status === 'offline' ? 'fail' : 'idle'}
                        label={
                          <span className="truncate">
                            {srv.name}
                            {srv.role === 'cloud' && <span className="ml-1 text-xs text-muted-foreground">{({ S3: 'Amazon S3', R2: 'Cloudflare R2', B2: 'Backblaze B2', MINIO: 'MinIO' } as Record<string, string>)[srv.kind ?? ''] ?? srv.kind}</span>}
                          </span>
                        }
                      />
                      <div className="h-2 overflow-hidden rounded bg-muted" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${srv.name} disk usage`}>
                        <div className={pct > 90 ? 'h-full bg-destructive' : pct > 75 ? 'h-full bg-warning' : 'h-full bg-[var(--series-1)]'} style={{ width: `${pct}%` }} />
                      </div>
                      <span
                        className="tabular text-xs text-muted-foreground"
                        title={srv.role === 'cloud' ? `${srv.objects ?? 0} objects${srv.partial ? ' (bucket scan incomplete)' : ''}${srv.checked_at ? ` · scanned ${new Date(srv.checked_at).toLocaleString()}` : ' · not scanned yet'}` : undefined}
                      >
                        {srv.total === null
                          ? srv.role === 'cloud'
                            ? `${formatBytes(srv.used ?? 0)} used · no quota set`
                            : 'Unknown'
                          : `${formatBytes(srv.free ?? 0)} free of ${formatBytes(srv.total)}${srv.role === 'cloud' ? ' quota' : ''}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
          <Panel className="mb-8 p-4">
            <h3 className="text-sm font-semibold">Default backend disk usage</h3>
            <p className="mt-1 text-xs text-muted-foreground">Local disk usage includes all other server applications and files. CDN usage is logical file size; other usage is estimated. Cloud providers may not report physical capacity.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">Volume total</div><div className="font-semibold">{d.disk_total === null ? 'Unknown' : formatBytes(d.disk_total)}</div></div>
              <div><div className="text-xs text-muted-foreground">Volume used (all apps)</div><div className="font-semibold">{d.disk_used === null ? 'Unknown' : formatBytes(d.disk_used)}</div></div>
              <div><div className="text-xs text-muted-foreground">Volume free</div><div className="font-semibold">{d.disk_free === null ? 'Unknown' : formatBytes(d.disk_free)}</div></div>
              <div><div className="text-xs text-muted-foreground">Non-CDN usage (estimate)</div><div className="font-semibold">{d.disk_other_used_estimate === null ? 'Unknown' : formatBytes(d.disk_other_used_estimate)}</div></div>
            </div>
          </Panel>
          {usedPct !== null && (
            <div className="mb-8">
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Estimated current usable capacity</span>
                <span className="tabular">
                  {formatBytes(d.used)} of {formatBytes(d.capacity)} ({usedPct.toFixed(1)}%)
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-muted" role="meter" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage usage">
                <div className={usedPct > 90 ? 'h-full bg-destructive' : usedPct > 75 ? 'h-full bg-warning' : 'h-full bg-[var(--series-1)]'} style={{ width: `${usedPct}%` }} />
              </div>
            </div>
          )}

          <Section title="Providers">
            <Panel>
              <Table>
                <THead>
                  <tr>
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH>Location</TH>
                    <TH className="text-right">Files</TH>
                    <TH className="text-right">Used</TH>
                    <TH className="text-right">Upload headroom</TH>
                    <TH>Status</TH>
                    <TH className="w-10" />
                  </tr>
                </THead>
                <tbody>
                  {d.providers.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium">
                        {p.name} {p.is_default && <Badge tone="info">Default</Badge>}
                        <span className="ml-2">
                          <StatusDot status={healthTone(p.health_status)} label={<span className="text-xs text-muted-foreground">{[p.region, p.latency_ms !== null ? `${p.latency_ms} ms` : p.health_status].filter(Boolean).join(' · ')}</span>} />
                        </span>
                      </TD>
                      <TD>{p.kind}</TD>
                      <TD className="max-w-[260px] truncate font-mono text-xs text-muted-foreground">{p.kind === 'POOL' ? <Link href="/dashboard/nodes" className="hover:underline">{p.public_info.level} · {p.public_info.nodes} nodes</Link> : p.public_info.root ?? [p.public_info.bucket, p.public_info.endpoint].filter(Boolean).join(' @ ')}</TD>
                      <TD className="text-right tabular">{formatNumber(p.file_count)}</TD>
                      <TD className="text-right tabular" title={p.bucket_used !== null ? `CDN files: ${formatBytes(p.used)} · whole bucket: ${formatBytes(p.bucket_used)} in ${formatNumber(p.bucket_objects ?? 0)} objects${p.bucket_usage_partial ? ' (scan incomplete)' : ''}${p.usage_checked_at ? ` · scanned ${new Date(p.usage_checked_at).toLocaleString()}` : ''}` : undefined}>
                        {formatBytes(p.used)}
                        {p.bucket_used !== null && p.bucket_used !== p.used && <div className="text-xs text-muted-foreground">bucket {formatBytes(p.bucket_used)}</div>}
                      </TD>
                      <TD className="text-right tabular" title={p.kind === 'LOCAL' ? 'Includes available volume space and configured quota' : 'Cloud storage quota only; physical free space is unknown'}>{p.available === null ? 'Unknown' : formatBytes(p.available)}</TD>
                      <TD>{p.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</TD>
                      <TD>
                        {manage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="xs" variant="ghost">
                                Manage
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuItem
                                onSelect={async () => {
                                  const r = await api<{ ok: boolean; error?: string }>(`/storage/providers/${p.id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, error: errorMessage(e) }));
                                  if (r.ok) toast.success('Connection OK');
                                  else toast.error(`Connection failed: ${r.error}`);
                                }}
                              >
                                Test connection
                              </DropdownMenuItem>
                              {p.public_info.source !== 'environment' && p.kind !== 'POOL' && <DropdownMenuItem onSelect={() => setDialog({ open: true, provider: p })}>Edit</DropdownMenuItem>}
                              {!p.is_default && (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    confirm({
                                      title: `Make ${p.name} the default?`,
                                      description: 'New uploads will be stored on this provider. Existing files are not moved.',
                                      requireReauth: true,
                                      confirmLabel: 'Change storage',
                                      successMessage: 'Default provider changed',
                                      action: async () => {
                                        await api(`/storage/providers/${p.id}`, { method: 'PATCH', body: { is_default: true } });
                                        void qc.invalidateQueries({ queryKey: ['storage'] });
                                      },
                                    })
                                  }
                                >
                                  Make default
                                </DropdownMenuItem>
                              )}
                              {!p.is_default && (
                                <DropdownMenuItem onSelect={() => void stepUp(async () => { await api(`/storage/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } }); void qc.invalidateQueries({ queryKey: ['storage'] }); }, { successMessage: p.enabled ? 'Provider disabled' : 'Provider enabled' })}>
                                  {p.enabled ? 'Disable' : 'Enable'}
                                </DropdownMenuItem>
                              )}
                              {!p.is_default && p.file_count === 0 && p.kind !== 'POOL' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() =>
                                      confirm({
                                        title: `Remove ${p.name}?`,
                                        destructive: true,
                                        requireReauth: true,
                                        confirmLabel: 'Remove provider',
                                        successMessage: 'Provider removed',
                                        action: async () => {
                                          await api(`/storage/providers/${p.id}`, { method: 'DELETE' });
                                          void qc.invalidateQueries({ queryKey: ['storage'] });
                                        },
                                      })
                                    }
                                  >
                                    Remove
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Panel>
          </Section>

          <div className="grid gap-8 lg:grid-cols-3">
            <Section title="Usage by type">
              <Panel className="p-4">
                <RankedBars rows={d.by_type.map((t) => ({ label: `${t.type} (${t.count})`, value: t.bytes }))} valueLabel={(n) => formatBytes(n)} />
              </Panel>
            </Section>
            <Section title="Largest files" className="lg:col-span-2">
              <Panel>
                {d.largest_files.length === 0 ? (
                  <EmptyState icon={HardDrive} title="No files stored" />
                ) : (
                  <Table>
                    <tbody>
                      {d.largest_files.map((f) => (
                        <TR key={f.id}>
                          <TD className="max-w-[360px] truncate">
                            <Link href={`/dashboard/files?file=${f.id}`} className="hover:underline">
                              {f.name}
                            </Link>
                          </TD>
                          <TD className="font-mono text-xs text-muted-foreground">{f.mime_type}</TD>
                          <TD className="text-right tabular">{formatBytes(f.size)}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>
            </Section>
          </div>
        </>
      )}
      <ProviderDialog open={dialog.open} provider={dialog.provider} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} />
    </>
  );
}
