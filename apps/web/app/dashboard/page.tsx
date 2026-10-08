'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FileDTO, SeriesPoint } from '@/lib/types';
import { formatBytes, formatNumber, timeAgo } from '@/lib/utils';
import { PageHeader, Section, Skeleton, ErrorState, Panel, EmptyState } from '@/components/ui/misc';
import { PeriodPicker, StatusCodeChart, TimeChart, periodQuery, type PeriodValue } from '@/components/charts';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { FileIcon } from '@/components/files/file-icon';
import { BarChart3 } from 'lucide-react';

interface Overview {
  range: { unit: 'hour' | 'day' };
  stats: {
    total_files: number;
    storage_used: number;
    storage_capacity: number | null;
    storage_available: number | null;
    disk_total: number | null;
    disk_free: number | null;
    disk_used: number | null;
    uploads_today: number;
    downloads_today: number;
    views_today: number;
    clicks_today: number;
    requests_today: number;
    bandwidth_today: number;
    bandwidth_month: number;
    active_api_keys: number;
    failed_api_requests_today: number;
  };
  series: SeriesPoint[];
  status_codes: { code: number; count: number }[];
  top_files: { id: string; name: string; downloads: number; bandwidth: number }[];
  recent_uploads: FileDTO[];
  recent_activity: { id: string; timestamp: string; actor: string | null; action: string; target_type: string | null; target_id: string | null }[];
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function OverviewPage() {
  const { can } = useSession();
  const [period, setPeriod] = React.useState<PeriodValue>({ period: '7d' });
  const q = useQuery({
    queryKey: ['overview', period],
    queryFn: () => api<Overview>('/dashboard/overview', { query: periodQuery(period) }),
    enabled: can('analytics.view'),
    refetchInterval: 60_000,
  });

  if (!can('analytics.view')) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel>
          <EmptyState icon={BarChart3} title="Welcome" description="Your role does not include analytics. Use the sidebar to get to the areas you can access." />
        </Panel>
      </>
    );
  }

  const d = q.data;
  const hourly = d?.range.unit === 'hour';

  return (
    <>
      <PageHeader title="Overview" description="Traffic, storage and activity across your CDN." actions={<PeriodPicker value={period} onChange={setPeriod} />} />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <div className="mb-8 grid grid-cols-2 divide-x divide-y rounded-lg border md:grid-cols-4 xl:grid-cols-6 [&>*]:border-border">
        {!d
          ? Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="px-4 py-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
              </div>
            ))
          : (
            <>
              <Stat label="Total files" value={formatNumber(d.stats.total_files)} />
              <Stat label="CDN storage used" value={formatBytes(d.stats.storage_used)} sub="CDN-managed files across all providers" />
              <Stat label="Upload headroom" value={d.stats.storage_available !== null ? formatBytes(d.stats.storage_available) : 'Unknown'} sub={d.stats.disk_free !== null ? `${formatBytes(d.stats.disk_free)} host disk free` : 'Provider has not reported physical free space'} />
              <Stat label="Uploads today" value={formatNumber(d.stats.uploads_today)} />
              <Stat label="Downloads today" value={formatNumber(d.stats.downloads_today)} />
              <Stat label="File views today" value={formatNumber(d.stats.views_today)} />
              <Stat label="Share clicks today" value={formatNumber(d.stats.clicks_today)} />
              <Stat label="Requests today" value={formatNumber(d.stats.requests_today)} />
              <Stat label="Bandwidth today" value={formatBytes(d.stats.bandwidth_today)} />
              <Stat label="Bandwidth this month" value={formatBytes(d.stats.bandwidth_month)} />
              <Stat label="Active API keys" value={formatNumber(d.stats.active_api_keys)} />
              <Stat label="Failed API requests" value={formatNumber(d.stats.failed_api_requests_today)} sub="today" />
              <Stat label="Most downloaded" value={<span className="block truncate text-sm">{[...d.top_files].sort((a, b) => b.downloads - a.downloads)[0]?.name ?? '—'}</span>} />
              <Stat label="Recent uploads" value={formatNumber(d.recent_uploads.length)} sub="latest shown below" />
            </>
          )}
      </div>

      <Section title="Traffic">
        {!d ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[230px]" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <TimeChart data={d.series} metric="requests" title="Requests" hourly={hourly} />
            <TimeChart data={d.series} metric="bandwidth" title="Bandwidth" unit="bytes" hourly={hourly} />
            <TimeChart data={d.series} metric="uploads" title="Uploads" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="downloads" title="Downloads" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="views" title="Inline views" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="clicks" title="Share clicks" hourly={hourly} kind="bar" />
          </div>
        )}
      </Section>

      <div className="grid gap-8 xl:grid-cols-3">
        <Section title="HTTP response codes">
          <Panel className="p-4">{d ? <StatusCodeChart data={d.status_codes} /> : <Skeleton className="h-32" />}</Panel>
        </Section>
        <Section title="Most downloaded files" className="xl:col-span-2">
          <Panel>
            {d && d.top_files.length === 0 ? (
              <EmptyState title="No downloads in this period" />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>File</TH>
                    <TH className="text-right">Downloads</TH>
                    <TH className="text-right">Bandwidth</TH>
                  </tr>
                </THead>
                <tbody>
                  {[...(d?.top_files ?? [])]
                    .sort((a, b) => b.downloads - a.downloads)
                    .map((f) => (
                      <TR key={f.id}>
                        <TD className="max-w-[320px] truncate">
                          <Link href={`/dashboard/files?file=${f.id}`} className="hover:underline">
                            {f.name}
                          </Link>
                        </TD>
                        <TD className="text-right tabular">{formatNumber(f.downloads)}</TD>
                        <TD className="text-right tabular">{formatBytes(f.bandwidth)}</TD>
                      </TR>
                    ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </Section>
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <Section title="Recent uploads" actions={<Link href="/dashboard/files" className="text-xs text-primary hover:underline">View all</Link>}>
          <Panel>
            {d && d.recent_uploads.length === 0 ? (
              <EmptyState title="No files yet" description="Upload your first file from the Files or Uploads page." />
            ) : (
              <ul className="divide-y">
                {(d?.recent_uploads ?? []).map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                    <FileIcon mime={f.mime_type} />
                    <Link href={`/dashboard/files?file=${f.id}`} className="min-w-0 flex-1 truncate text-[13px] hover:underline">
                      {f.name}
                    </Link>
                    <span className="text-xs text-muted-foreground tabular">{formatBytes(f.size)}</span>
                    <span className="w-20 text-right text-xs text-muted-foreground">{timeAgo(f.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>
        <Section title="Recent staff activity" actions={can('logs.view') ? <Link href="/dashboard/activity" className="text-xs text-primary hover:underline">View all</Link> : undefined}>
          <Panel>
            {d && d.recent_activity.length === 0 ? (
              <EmptyState title={can('logs.view') ? 'No activity yet' : 'Activity requires logs.view'} />
            ) : (
              <ul className="divide-y">
                {(d?.recent_activity ?? []).map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{a.action}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.actor ?? 'system'}</span>
                    <span className="text-xs text-muted-foreground">{timeAgo(a.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>
      </div>
    </>
  );
}
