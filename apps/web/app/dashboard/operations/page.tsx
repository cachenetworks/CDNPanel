'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RotateCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, formatBytes, formatDate, formatNumber, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, ErrorState, PageHeader, Pagination, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { Stat, StatGrid, StatusDot, healthTone } from '@/components/ui/stat';
import { useConfirm } from '@/components/confirm';

interface Overview {
  latency: { kind: string; p50_ms: number; p95_ms: number; p99_ms: number; requests: number; errors_5xx: number }[];
  per_minute: { t: string; requests: number; bytes: number; p95_ms: number }[];
  dependencies: { postgres: { ok: boolean; ms: number | null }; redis: { ok: boolean; ms: number | null } };
  storage: { id: string; name: string; kind: string; region: string; healthStatus: string; latencyMs: number | null; healthCheckedAt: string | null; enabled: boolean }[];
  queues: { name: string; counts: Record<string, number>; paused: boolean; completed_per_minute: number; failed_per_minute: number }[];
  webhooks: Record<string, number>;
  files: { quarantined: number; failed: number; scan_failures: number };
  worker: { heartbeat_age_seconds: number | null; healthy: boolean };
}

interface Job {
  id: string;
  name: string;
  state: string | null;
  data: unknown;
  attempts_made: number;
  attempts: number;
  failed_reason: string | null;
  stacktrace: string | null;
  created_at: string;
  processed_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

const STATES = ['failed', 'active', 'waiting', 'delayed', 'completed'] as const;
const QUEUE_LABEL: Record<string, string> = {
  'file-processing': 'File processing',
  webhooks: 'Webhooks',
  maintenance: 'Maintenance',
  media: 'Media (FFmpeg)',
  replication: 'Replication',
  edge: 'Edge purges & pre-warm',
};

function MiniChart({ data, dataKey, format, label }: { data: Overview['per_minute']; dataKey: 'requests' | 'p95_ms' | 'bytes'; format: (n: number) => string; label: string }) {
  const tick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">{label}</h3>
      <div className="h-36" role="img" aria-label={`${label} per minute, last hour`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="t" tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={tick} axisLine={false} tickLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v) => format(v)} tick={tick} axisLine={false} tickLine={false} width={52} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} labelFormatter={(t) => new Date(String(t)).toLocaleTimeString()} formatter={(v) => [format(Number(v)), label]} />
            <Area type="monotone" dataKey={dataKey} stroke="var(--series-1)" fill="var(--series-1)" fillOpacity={0.12} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function JobQueue({ queue, manage }: { queue: Overview['queues'][number]; manage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [state, setState] = React.useState<(typeof STATES)[number]>(queue.counts.failed ? 'failed' : 'active');
  const [page, setPage] = React.useState(1);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ['jobs', queue.name, state, page],
    queryFn: () => api<{ data: Job[]; pagination: { total: number; total_pages: number } }>(`/ops/queues/${queue.name}/jobs`, { query: { state, page, limit: 20 } }),
    refetchInterval: 5000,
  });
  const detail = useQuery({ queryKey: ['job', queue.name, viewing], queryFn: () => api<Job & { stacktrace_full: string[]; logs: string[]; return_value: unknown }>(`/ops/queues/${queue.name}/jobs/${encodeURIComponent(viewing!)}`), enabled: Boolean(viewing) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['jobs', queue.name] });
    void qc.invalidateQueries({ queryKey: ['ops'] });
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="inline-flex rounded-md border p-0.5">
          {STATES.map((s) => (
            <button key={s} type="button" onClick={() => (setState(s), setPage(1))} className={cn('rounded px-2 py-1 text-xs text-muted-foreground', state === s && 'bg-accent font-medium text-foreground')}>
              {s} <span className="tabular">{formatNumber(queue.counts[s] ?? 0)}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {manage && (
          <>
            {(queue.counts.failed ?? 0) > 0 && (
              <Button size="xs" variant="secondary" onClick={() => act(() => api(`/ops/queues/${queue.name}/retry-failed`, { method: 'POST' }), 'Failed jobs re-queued')}>
                <RotateCw /> Retry all failed
              </Button>
            )}
            <Button size="xs" variant="secondary" onClick={() => act(() => api(`/ops/queues/${queue.name}/${queue.paused ? 'resume' : 'pause'}`, { method: 'POST' }), queue.paused ? 'Queue resumed' : 'Queue paused')}>
              {queue.paused ? <Play /> : <Pause />} {queue.paused ? 'Resume' : 'Pause'}
            </Button>
            {(state === 'completed' || state === 'failed') && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  confirm({
                    title: `Clean ${state} jobs?`,
                    description: `Removes ${state} jobs older than one hour from ${QUEUE_LABEL[queue.name] ?? queue.name}.`,
                    confirmLabel: 'Clean',
                    action: async () => {
                      await api(`/ops/queues/${queue.name}/clean`, { body: { state, older_than_hours: 1 } });
                      refresh();
                    },
                  })
                }
              >
                Clean
              </Button>
            )}
          </>
        )}
      </div>
      {!jobs.data ? (
        <Skeleton className="m-3 h-24" />
      ) : jobs.data.data.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No {state} jobs.</p>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              <TH>Data</TH>
              <TH>Attempts</TH>
              <TH>{state === 'failed' ? 'Error' : 'Duration'}</TH>
              <TH>Created</TH>
              <TH className="w-24" />
            </tr>
          </THead>
          <tbody>
            {jobs.data.data.map((j) => (
              <TR key={j.id} className="cursor-pointer" onClick={() => setViewing(j.id)}>
                <TD className="font-mono text-xs">{j.name}</TD>
                <TD className="max-w-[280px] truncate font-mono text-[11px] text-muted-foreground">{JSON.stringify(j.data)}</TD>
                <TD className="tabular text-xs">
                  {j.attempts_made}/{j.attempts}
                </TD>
                <TD className="max-w-[280px] truncate text-xs">{state === 'failed' ? <span className="text-destructive">{j.failed_reason}</span> : j.duration_ms !== null ? `${j.duration_ms} ms` : '—'}</TD>
                <TD className="whitespace-nowrap text-xs text-muted-foreground">{timeAgo(j.created_at)}</TD>
                <TD onClick={(e) => e.stopPropagation()}>
                  {manage && (
                    <div className="flex justify-end gap-1">
                      {state === 'failed' && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Retry job" onClick={() => act(() => api(`/ops/queues/${queue.name}/jobs/${encodeURIComponent(j.id)}/retry`, { method: 'POST' }), 'Job re-queued')}>
                          <RotateCw />
                        </Button>
                      )}
                      {state !== 'active' && (
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Remove job" onClick={() => act(() => api(`/ops/queues/${queue.name}/jobs/${encodeURIComponent(j.id)}`, { method: 'DELETE' }), 'Job removed')}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
      {jobs.data && <Pagination page={page} totalPages={jobs.data.pagination.total_pages} total={jobs.data.pagination.total} onPage={setPage} />}
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent size="xl">
          <DialogHeader title={`${detail.data?.name ?? 'Job'} · ${viewing ?? ''}`} description={detail.data ? `${detail.data.state} · attempt ${detail.data.attempts_made}/${detail.data.attempts} · created ${formatDate(detail.data.created_at)}` : undefined} />
          <DialogBody>
            {!detail.data ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Data</h4>
                <pre className="overflow-x-auto rounded bg-subtle p-3 text-xs">{JSON.stringify(detail.data.data, null, 2)}</pre>
                {detail.data.failed_reason && (
                  <>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Error</h4>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[hsl(var(--destructive)/0.06)] p-3 text-xs text-destructive">{detail.data.stacktrace_full.at(-1) ?? detail.data.failed_reason}</pre>
                  </>
                )}
                {detail.data.return_value !== undefined && detail.data.return_value !== null && (
                  <>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</h4>
                    <pre className="overflow-x-auto rounded bg-subtle p-3 text-xs">{JSON.stringify(detail.data.return_value, null, 2)}</pre>
                  </>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

export default function OperationsPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['ops'], queryFn: () => api<Overview>('/ops/overview'), refetchInterval: 10_000 });
  const [queue, setQueue] = React.useState('file-processing');
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const delivery = d?.latency.filter((l) => l.kind !== 'api') ?? [];
  const apiLat = d?.latency.find((l) => l.kind === 'api');
  const depth = d?.queues.reduce((a, x) => a + (x.counts.waiting ?? 0) + (x.counts.delayed ?? 0), 0) ?? 0;
  const jobsPerMin = d?.queues.reduce((a, x) => a + x.completed_per_minute, 0) ?? 0;
  const current = d?.queues.find((x) => x.name === queue);
  return (
    <>
      <PageHeader title="Operations" description="Live health of the API, worker, database, Redis, storage and background queues. Prometheus metrics are exposed at /metrics." />
      {!d ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <StatGrid className="mb-6">
            <Stat label="API latency p50 / p95 / p99" value={apiLat ? `${apiLat.p50_ms} / ${apiLat.p95_ms} / ${apiLat.p99_ms}` : '—'} sub="ms, last hour" />
            <Stat label="Delivery p95" value={delivery.length ? `${Math.max(...delivery.map((l) => l.p95_ms))} ms` : '—'} sub={`${formatNumber(delivery.reduce((a, l) => a + l.requests, 0))} requests / h`} />
            <Stat label="5xx errors" value={formatNumber(d.latency.reduce((a, l) => a + l.errors_5xx, 0))} sub="last hour" />
            <Stat label="Queue depth" value={formatNumber(depth)} sub={`${jobsPerMin.toFixed(1)} jobs / min completed`} />
            <Stat label="Webhook backlog" value={formatNumber((d.webhooks.pending ?? 0) + (d.webhooks.failed ?? 0))} sub={`${d.webhooks.failed ?? 0} failed (24h)`} />
            <Stat label="Quarantined files" value={formatNumber(d.files.quarantined)} sub={`${d.files.failed} failed processing`} />
          </StatGrid>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <MiniChart data={d.per_minute} dataKey="requests" format={formatNumber} label="Requests / minute" />
            <MiniChart data={d.per_minute} dataKey="p95_ms" format={(n) => `${n} ms`} label="p95 latency" />
            <MiniChart data={d.per_minute} dataKey="bytes" format={(n) => formatBytes(n)} label="Bytes / minute" />
          </div>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Section title="Dependencies">
              <Panel className="divide-y">
                {[
                  ['PostgreSQL', d.dependencies.postgres.ok, d.dependencies.postgres.ms],
                  ['Redis', d.dependencies.redis.ok, d.dependencies.redis.ms],
                ].map(([name, ok, ms]) => (
                  <div key={String(name)} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span>{name}</span>
                    <StatusDot status={ok ? 'ok' : 'fail'} label={ok ? `${ms} ms` : 'unreachable'} />
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                  <span>Worker</span>
                  <StatusDot status={d.worker.healthy ? 'ok' : 'fail'} label={d.worker.heartbeat_age_seconds === null ? 'no heartbeat' : `heartbeat ${d.worker.heartbeat_age_seconds}s ago`} />
                </div>
              </Panel>
            </Section>
            <Section title="Storage providers">
              <Panel className="divide-y">
                {d.storage.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <span className="min-w-0 truncate">
                      {p.name} <span className="text-xs text-muted-foreground">{p.kind}{p.region ? ` · ${p.region}` : ''}</span>
                    </span>
                    <StatusDot status={p.enabled ? healthTone(p.healthStatus) : 'idle'} label={p.latencyMs !== null ? `${p.latencyMs} ms · ${timeAgo(p.healthCheckedAt)}` : p.healthStatus} />
                  </div>
                ))}
              </Panel>
            </Section>
          </div>

          <Section title="Job queues">
            <div className="mb-2 flex flex-wrap gap-1">
              {d.queues.map((x) => (
                <button
                  key={x.name}
                  type="button"
                  onClick={() => setQueue(x.name)}
                  className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs', queue === x.name ? 'border-primary bg-[hsl(var(--primary)/0.06)] font-medium' : 'text-muted-foreground')}
                >
                  {QUEUE_LABEL[x.name] ?? x.name}
                  {(x.counts.failed ?? 0) > 0 && <Badge tone="danger">{x.counts.failed} failed</Badge>}
                  {(x.counts.active ?? 0) > 0 && <Badge tone="info">{x.counts.active} active</Badge>}
                  {x.paused && <Badge tone="warning">Paused</Badge>}
                </button>
              ))}
            </div>
            {current && <JobQueue key={current.name} queue={current} manage={can('ops.manage')} />}
          </Section>
        </>
      )}
    </>
  );
}
