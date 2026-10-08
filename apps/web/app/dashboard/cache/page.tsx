'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flame, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ZoneDTO } from '@/lib/types';
import { formatBytes, formatDate, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect, Textarea } from '@/components/ui/form';
import { Badge, ErrorState, PageHeader, Panel, Pagination, Section, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { RankedBars } from '@/components/charts';
import { Stat, StatGrid } from '@/components/ui/stat';
import { useConfirm } from '@/components/confirm';

interface CacheStats {
  period: string;
  origin: {
    statuses: { status: string; requests: number; bytes: number }[];
    hit_ratio: number;
    series: { t: string; hits: number; misses: number }[];
    top_origin_files: { id: string; name: string; requests: number; bytes: number }[];
  };
  edge: { statuses: { status: string; requests: number; bytes: number }[]; hit_ratio: number; since: string } | null;
  edge_error: string | null;
  edge_configured: boolean;
}

interface Purge {
  id: string;
  zone_id: string | null;
  type: string;
  targets: string[];
  status: string;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  edge_result: { results?: { ok: boolean; error?: string }[] };
}

const PURGE_HELP: Record<string, { label: string; placeholder: string; hint: string }> = {
  url: { label: 'URLs', placeholder: 'https://assets.example.com/logo.png', hint: 'One full URL per line.' },
  file: { label: 'File IDs', placeholder: 'file_01J…', hint: 'Purges every URL of the file, signed URLs and image variants (via cache tags).' },
  folder: { label: 'Folder IDs', placeholder: 'fld_01J…', hint: 'Purges everything below the folder (prefix + tag purge).' },
  tag: { label: 'Cache tags', placeholder: 'release:v2', hint: 'Files carry file:, folder:, zone:, project: tags plus your own tags.' },
  zone: { label: 'Zone', placeholder: '', hint: 'Purges every hostname of the selected zone.' },
  everything: { label: 'Everything', placeholder: '', hint: 'Purges the whole Cloudflare zone. Expect a burst of origin traffic.' },
};

const STATUS_LABEL: Record<string, string> = {
  origin: 'Served from origin',
  revalidated: '304 revalidated',
  'variant-hit': 'Image variant hit',
  'variant-miss': 'Image variant generated',
  'range-start': 'Range (first chunk)',
  range: 'Range',
  redirect: 'Redirect to storage',
};

function HitMissChart({ data }: { data: CacheStats['origin']['series'] }) {
  const tick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
  return (
    <div className="h-48" role="img" aria-label="Origin hits and misses over time">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="t" tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={tick} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={(v) => formatNumber(v)} tick={tick} axisLine={false} tickLine={false} width={48} allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} labelFormatter={(t) => new Date(String(t)).toLocaleString()} />
          <Bar dataKey="hits" name="Hits" stackId="a" fill="var(--series-2)" />
          <Bar dataKey="misses" name="Misses" stackId="a" fill="var(--series-1)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CachePage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [zoneId, setZoneId] = React.useState('');
  const [period, setPeriod] = React.useState<'24h' | '7d' | '30d'>('24h');
  const [type, setType] = React.useState('url');
  const [targets, setTargets] = React.useState('');
  const [page, setPage] = React.useState(1);
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ data: ZoneDTO[] }>('/zones'), enabled: can('zones.view') });
  const stats = useQuery({ queryKey: ['cache-stats', zoneId, period], queryFn: () => api<CacheStats>('/cache/stats', { query: { zone_id: zoneId || undefined, period } }) });
  const purges = useQuery({ queryKey: ['purges', page], queryFn: () => api<Paginated<Purge>>('/cache/purges', { query: { page, limit: 20 } }), refetchInterval: 10_000 });

  const submit = async () => {
    const list = type === 'zone' ? [zoneId] : targets.split(/[\n,\s]+/).map((t) => t.trim()).filter(Boolean);
    const run = async () => {
      await api('/cache/purge', { body: { type, targets: type === 'everything' ? [] : list, zone_id: zoneId || undefined } });
      setTargets('');
      void qc.invalidateQueries({ queryKey: ['purges'] });
    };
    if (type === 'everything' || type === 'zone') {
      confirm({ title: type === 'everything' ? 'Purge everything?' : 'Purge the whole zone?', description: PURGE_HELP[type]!.hint, destructive: true, confirmLabel: 'Purge', successMessage: 'Purge queued', action: run });
    } else {
      try {
        await run();
        toast.success('Purge queued');
      } catch (err) {
        toast.error(errorMessage(err));
      }
    }
  };

  const s = stats.data;
  const edgeTotal = s?.edge?.statuses.reduce((a, x) => a + x.requests, 0) ?? 0;
  return (
    <>
      <PageHeader
        title="Cache"
        description="Edge cache statistics, purges and pre-warming. Files carry Cache-Tag headers so a purge also covers signed URLs and image variants."
        actions={
          <div className="flex gap-2">
            {zones.data && (
              <NativeSelect value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Zone">
                <option value="">All zones</option>
                {zones.data.data.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <NativeSelect value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} aria-label="Period">
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </NativeSelect>
          </div>
        }
      />
      {stats.isError && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
      {!s ? (
        <Skeleton className="h-28" />
      ) : (
        <StatGrid className="mb-6 lg:grid-cols-4">
          <Stat label="Edge hit ratio" value={s.edge ? `${(s.edge.hit_ratio * 100).toFixed(1)}%` : '—'} sub={s.edge ? `${formatNumber(edgeTotal)} edge requests (24h)` : s.edge_configured ? (s.edge_error ?? 'No data') : 'Connect Cloudflare on a zone'} />
          <Stat label="Origin hit ratio" value={`${(s.origin.hit_ratio * 100).toFixed(1)}%`} sub="304s and image variant hits" />
          <Stat label="Origin requests" value={formatNumber(s.origin.statuses.reduce((a, x) => a + x.requests, 0))} />
          <Stat label="Origin egress" value={formatBytes(s.origin.statuses.reduce((a, x) => a + x.bytes, 0))} />
        </StatGrid>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Edge cache status" description="HIT / MISS / EXPIRED / BYPASS from Cloudflare analytics (last 24 hours).">
          <Panel className="p-4">
            {s?.edge ? (
              <RankedBars rows={s.edge.statuses.map((x) => ({ label: x.status.toUpperCase(), value: x.requests, hint: formatBytes(x.bytes) }))} valueLabel={formatNumber} />
            ) : (
              <p className="text-[13px] text-muted-foreground">{s?.edge_error ?? 'Edge statistics need Cloudflare credentials (zone → Cache → Cloudflare, or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID).'}</p>
            )}
          </Panel>
        </Section>
        <Section title="Origin outcomes">
          <Panel className="p-4">{s && <RankedBars rows={s.origin.statuses.map((x) => ({ label: STATUS_LABEL[x.status] ?? x.status, value: x.requests, hint: formatBytes(x.bytes) }))} valueLabel={formatNumber} />}</Panel>
        </Section>
      </div>
      {s && s.origin.series.length > 0 && (
        <Section title="Origin hits vs misses">
          <Panel className="p-4">
            <HitMissChart data={s.origin.series} />
          </Panel>
        </Section>
      )}
      {can('cache.purge') && (
        <Section title="Purge">
          <Panel className="space-y-4 p-4">
            <div className="flex flex-wrap gap-1">
              {Object.entries(PURGE_HELP).map(([k, v]) => (
                <Button key={k} size="xs" variant={type === k ? 'default' : 'secondary'} onClick={() => setType(k)}>
                  {v.label}
                </Button>
              ))}
            </div>
            {type !== 'everything' && type !== 'zone' && (
              <Field label={PURGE_HELP[type]!.label} hint={PURGE_HELP[type]!.hint}>
                <Textarea value={targets} onChange={(e) => setTargets(e.target.value)} placeholder={PURGE_HELP[type]!.placeholder} rows={4} className="font-mono text-xs" />
              </Field>
            )}
            {(type === 'zone' || type === 'everything') && <p className="text-[13px] text-muted-foreground">{PURGE_HELP[type]!.hint}{type === 'zone' && !zoneId && ' Select a zone at the top of the page.'}</p>}
            <div className="flex gap-2">
              <Button onClick={submit} disabled={(type === 'zone' && !zoneId) || (!['zone', 'everything'].includes(type) && !targets.trim())}>
                <Zap /> Purge
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    const r = await api<{ urls: number }>('/cache/prewarm', { body: { top: 50, zone_id: zoneId || undefined } });
                    toast.success(`Pre-warming ${r.urls} URLs through the edge`);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Flame /> Pre-warm top 50 files
              </Button>
            </div>
          </Panel>
        </Section>
      )}
      {s && s.origin.top_origin_files.length > 0 && (
        <Section title="Most fetched from origin" description="Candidates for longer edge TTLs or pre-warming.">
          <Panel className="p-4">
            <RankedBars rows={s.origin.top_origin_files.map((f) => ({ label: f.name, value: f.requests, hint: formatBytes(f.bytes) }))} valueLabel={formatNumber} />
          </Panel>
        </Section>
      )}
      <Section title="Purge history">
        <Panel>
          {!purges.data ? (
            <Skeleton className="m-3 h-24" />
          ) : purges.data.data.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No purges yet.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Type</TH>
                  <TH>Targets</TH>
                  <TH>Status</TH>
                  <TH>By</TH>
                </tr>
              </THead>
              <tbody>
                {purges.data.data.map((p) => (
                  <TR key={p.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">{formatDate(p.created_at)}</TD>
                    <TD>
                      <Badge tone="outline">{p.type}</Badge>
                    </TD>
                    <TD className="max-w-xs truncate font-mono text-[11px]" title={p.targets.join('\n')}>
                      {p.targets.length ? `${p.targets.slice(0, 2).join(', ')}${p.targets.length > 2 ? ` +${p.targets.length - 2}` : ''}` : '—'}
                    </TD>
                    <TD>
                      <Badge tone={p.status === 'completed' ? 'success' : p.status === 'failed' ? 'danger' : p.status === 'pending' ? 'warning' : 'neutral'} title={p.edge_result.results?.find((r) => !r.ok)?.error}>
                        {p.status.replace('_', ' ')}
                      </Badge>
                    </TD>
                    <TD className="text-xs text-muted-foreground">{p.created_by ?? 'system'}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          {purges.data && <Pagination page={page} totalPages={purges.data.pagination.total_pages} total={purges.data.pagination.total} onPage={setPage} />}
        </Panel>
      </Section>
    </>
  );
}
