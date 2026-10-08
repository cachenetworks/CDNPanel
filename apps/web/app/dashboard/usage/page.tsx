'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ApiKeyDTO, CostLine, ProjectDTO, QuotaDTO, UsageMetrics, ZoneDTO } from '@/lib/types';
import { cn, formatBytes, formatDate, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, NativeSelect, Switch } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { Stat, StatGrid } from '@/components/ui/stat';
import { useConfirm } from '@/components/confirm';

interface Overview {
  period_start: string;
  global: UsageMetrics;
  projects: { id: string; name: string; usage: UsageMetrics; cost: number }[];
  zones: { id: string; name: string; project_id: string; usage: UsageMetrics }[];
  quotas: QuotaDTO[];
  cost: { currency: string; total: number; lines: CostLine[] };
}

const METRIC_LABEL: Record<QuotaDTO['metric'], string> = {
  storage_bytes: 'Storage',
  egress_bytes: 'Egress',
  requests: 'Requests',
  transforms: 'Image transforms',
  upload_bytes: 'Uploads',
};
const BYTE_METRICS = new Set(['storage_bytes', 'egress_bytes', 'upload_bytes']);
const fmt = (metric: string, n: number) => (BYTE_METRICS.has(metric) ? formatBytes(n) : formatNumber(n));
const money = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);

/** Quota meter: used / limit with threshold ticks. */
function Meter({ q }: { q: QuotaDTO }) {
  const pct = Math.min(100, q.percent ?? 0);
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 90 ? 'bg-[hsl(var(--warning))]' : 'bg-primary';
  return (
    <div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${METRIC_LABEL[q.metric]} quota`}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
        {q.thresholds
          .filter((t) => t < 100)
          .map((t) => (
            <span key={t} className="absolute top-0 h-full w-px bg-background" style={{ left: `${t}%` }} />
          ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span className="tabular">
          {fmt(q.metric, q.used ?? 0)} of {fmt(q.metric, q.limit)}
        </span>
        <span className="tabular">{(q.percent ?? 0).toFixed(1)}%</span>
      </div>
    </div>
  );
}

const UNIT: Record<string, number> = { GB: 1024 ** 3, TB: 1024 ** 4, M: 1_000_000, K: 1_000, '1': 1 };

function QuotaDialog({ open, onOpenChange, projects, zones, keys }: { open: boolean; onOpenChange: (o: boolean) => void; projects: ProjectDTO[]; zones: ZoneDTO[]; keys: ApiKeyDTO[] }) {
  const qc = useQueryClient();
  const [scope, setScope] = React.useState('global:');
  const [metric, setMetric] = React.useState<QuotaDTO['metric']>('egress_bytes');
  const [limit, setLimit] = React.useState('100');
  const [unit, setUnit] = React.useState('GB');
  const [hard, setHard] = React.useState(false);
  const [thresholds, setThresholds] = React.useState('50, 75, 90, 100');
  React.useEffect(() => {
    if (open) {
      setScope('global:');
      setMetric('egress_bytes');
      setLimit('100');
      setUnit('GB');
      setHard(false);
    }
  }, [open]);
  React.useEffect(() => setUnit(BYTE_METRICS.has(metric) ? 'GB' : 'M'), [metric]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Set a quota" description="Monthly limits (UTC calendar month; storage is a running total). Alerts fire as usage crosses each threshold." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const [scopeType, scopeId] = scope.split(':') as [string, string];
            try {
              await api('/quotas', {
                body: {
                  scope_type: scopeType,
                  scope_id: scopeId,
                  metric,
                  limit: Math.round(Number(limit) * (UNIT[unit] ?? 1)),
                  hard,
                  thresholds: thresholds.split(',').map((t) => Number(t.trim())).filter((n) => n > 0),
                },
              });
              toast.success('Quota saved');
              void qc.invalidateQueries({ queryKey: ['usage-overview'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <Field label="Scope">
              <NativeSelect className="w-full" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="global:">Whole platform</option>
                <optgroup label="Projects">
                  {projects.map((p) => (
                    <option key={p.id} value={`project:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Zones">
                  {zones.map((z) => (
                    <option key={z.id} value={`zone:${z.id}`}>
                      {z.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="API keys">
                  {keys.map((k) => (
                    <option key={k.id} value={`api_key:${k.id}`}>
                      {k.name} ({k.prefix})
                    </option>
                  ))}
                </optgroup>
              </NativeSelect>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Metric">
                <NativeSelect className="w-full" value={metric} onChange={(e) => setMetric(e.target.value as QuotaDTO['metric'])}>
                  {Object.entries(METRIC_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Limit">
                <div className="flex gap-2">
                  <Input type="number" min={0.001} step="any" value={limit} onChange={(e) => setLimit(e.target.value)} required />
                  <NativeSelect value={unit} onChange={(e) => setUnit(e.target.value)}>
                    {BYTE_METRICS.has(metric) ? (
                      <>
                        <option value="GB">GB</option>
                        <option value="TB">TB</option>
                      </>
                    ) : (
                      <>
                        <option value="K">thousand</option>
                        <option value="M">million</option>
                        <option value="1">exact</option>
                      </>
                    )}
                  </NativeSelect>
                </div>
              </Field>
            </div>
            <Field label="Alert thresholds (%)">
              <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
            </Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Hard limit</Label>
                <p className="text-xs text-muted-foreground">Block further delivery / uploads with “quota exceeded” once the limit is reached.</p>
              </div>
              <Switch checked={hard} onCheckedChange={setHard} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save quota</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function UsagePage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState(false);
  const q = useQuery({ queryKey: ['usage-overview'], queryFn: () => api<Overview>('/usage/overview'), refetchInterval: 60_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ data: ProjectDTO[] }>('/projects'), enabled: can('quotas.manage') });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ data: ZoneDTO[] }>('/zones'), enabled: can('quotas.manage') });
  const keys = useQuery({ queryKey: ['api-keys', 'all-active'], queryFn: () => api<{ data: ApiKeyDTO[] }>('/api-keys', { query: { status: 'active', limit: 200 } }), enabled: can('quotas.manage') && can('api_keys.view') });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const scopeName = (qq: QuotaDTO) =>
    qq.scope_type === 'global' ? 'Platform' : qq.scope_type === 'project' ? (d?.projects.find((p) => p.id === qq.scope_id)?.name ?? qq.scope_id) : qq.scope_type === 'zone' ? (d?.zones.find((z) => z.id === qq.scope_id)?.name ?? qq.scope_id) : `API key ${qq.scope_id}`;
  return (
    <>
      <PageHeader
        title="Usage & Costs"
        description={d ? `Month to date since ${formatDate(d.period_start, false)} (UTC). Cost estimates use the prices configured on each storage provider.` : undefined}
        actions={
          can('quotas.manage') && (
            <Button onClick={() => setDialog(true)}>
              <Plus /> Set quota
            </Button>
          )
        }
      />
      {!d ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <StatGrid className="mb-6">
            <Stat label="Storage" value={formatBytes(d.global.storage_bytes)} />
            <Stat label="Egress" value={formatBytes(d.global.egress_bytes)} />
            <Stat label="Requests" value={formatNumber(d.global.requests)} />
            <Stat label="Image transforms" value={formatNumber(d.global.transforms)} sub={`${formatNumber(Math.round(d.global.cpu_ms / 1000))} CPU seconds`} />
            <Stat label="Uploaded" value={formatBytes(d.global.upload_bytes)} />
            <Stat label="Estimated cost" value={money(d.cost.total, d.cost.currency)} />
          </StatGrid>

          <Section title="Quotas">
            {d.quotas.length === 0 ? (
              <Panel>
                <EmptyState icon={Gauge} title="No quotas" description="Set soft limits for alerts or hard limits that block usage, per project, zone or API key." />
              </Panel>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {d.quotas.map((qq) => (
                  <Panel key={qq.id} className="space-y-2 p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium">{METRIC_LABEL[qq.metric]}</span>
                      <span className="truncate text-xs text-muted-foreground">· {scopeName(qq)}</span>
                      <div className="flex-1" />
                      <Badge tone={qq.hard ? 'danger' : 'outline'}>{qq.hard ? 'Hard' : 'Soft'}</Badge>
                      {can('quotas.manage') && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label="Delete quota"
                          onClick={() =>
                            confirm({
                              title: 'Delete this quota?',
                              destructive: true,
                              confirmLabel: 'Delete',
                              successMessage: 'Quota deleted',
                              action: async () => {
                                await api(`/quotas/${qq.id}`, { method: 'DELETE' });
                                void qc.invalidateQueries({ queryKey: ['usage-overview'] });
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                    <Meter q={qq} />
                  </Panel>
                ))}
              </div>
            )}
          </Section>

          <Section title="Cost estimate by storage provider">
            <Panel>
              {d.cost.lines.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Set prices on your storage providers (Storage page) to see cost estimates.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Provider</TH>
                      <TH className="text-right">Stored</TH>
                      <TH className="text-right">Egress</TH>
                      <TH className="text-right">Storage cost</TH>
                      <TH className="text-right">Egress cost</TH>
                      <TH className="text-right">Requests cost</TH>
                      <TH className="text-right">Total</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {d.cost.lines.map((l) => (
                      <TR key={l.provider.id}>
                        <TD>
                          {l.provider.name} <span className="text-xs text-muted-foreground">{l.provider.kind}</span>
                        </TD>
                        <TD className="text-right tabular">{formatBytes(l.storage_bytes)}</TD>
                        <TD className="text-right tabular">{formatBytes(l.egress_bytes)}</TD>
                        <TD className="text-right tabular">{money(l.storage_cost, d.cost.currency)}</TD>
                        <TD className="text-right tabular">{money(l.egress_cost, d.cost.currency)}</TD>
                        <TD className="text-right tabular">{money(l.request_cost, d.cost.currency)}</TD>
                        <TD className="text-right font-medium tabular">{money(l.total, d.cost.currency)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>

          <Section title="By project">
            <Panel>
              <Table>
                <THead>
                  <tr>
                    <TH>Project</TH>
                    <TH className="text-right">Storage</TH>
                    <TH className="text-right">Egress</TH>
                    <TH className="text-right">Requests</TH>
                    <TH className="text-right">Transforms</TH>
                    <TH className="text-right">Est. cost</TH>
                  </tr>
                </THead>
                <tbody>
                  {d.projects.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium">{p.name}</TD>
                      <TD className="text-right tabular">{formatBytes(p.usage.storage_bytes)}</TD>
                      <TD className="text-right tabular">{formatBytes(p.usage.egress_bytes)}</TD>
                      <TD className="text-right tabular">{formatNumber(p.usage.requests)}</TD>
                      <TD className="text-right tabular">{formatNumber(p.usage.transforms)}</TD>
                      <TD className="text-right tabular">{money(p.cost, d.cost.currency)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Panel>
          </Section>

          {d.zones.length > 0 && (
            <Section title="By zone">
              <Panel>
                <Table>
                  <THead>
                    <tr>
                      <TH>Zone</TH>
                      <TH className="text-right">Storage</TH>
                      <TH className="text-right">Egress</TH>
                      <TH className="text-right">Requests</TH>
                      <TH className="text-right">Transforms</TH>
                      <TH className="text-right">Uploaded</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {d.zones.map((z) => (
                      <TR key={z.id}>
                        <TD className="font-medium">{z.name}</TD>
                        <TD className="text-right tabular">{formatBytes(z.usage.storage_bytes)}</TD>
                        <TD className="text-right tabular">{formatBytes(z.usage.egress_bytes)}</TD>
                        <TD className="text-right tabular">{formatNumber(z.usage.requests)}</TD>
                        <TD className="text-right tabular">{formatNumber(z.usage.transforms)}</TD>
                        <TD className="text-right tabular">{formatBytes(z.usage.upload_bytes)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Panel>
            </Section>
          )}
        </>
      )}
      <QuotaDialog open={dialog} onOpenChange={setDialog} projects={projects.data?.data ?? []} zones={zones.data?.data ?? []} keys={keys.data?.data ?? []} />
    </>
  );
}
