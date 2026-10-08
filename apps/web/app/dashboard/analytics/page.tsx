'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage, type Paginated } from '@/lib/api';
import type { ApiKeyDTO, SeriesPoint } from '@/lib/types';
import { formatBytes, formatDate, formatNumber } from '@/lib/utils';
import { useSession } from '@/lib/session';
import { NativeSelect } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { DeliveryMap, countryName, type GeoData } from '@/components/analytics/delivery-map';
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Section, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { PeriodPicker, RankedBars, StatusCodeChart, TimeChart, periodQuery, type PeriodValue } from '@/components/charts';

interface Analytics {
  range: { unit: 'hour' | 'day' };
  totals: { requests: number; downloads: number; views: number; clicks: number; bandwidth: number; errors: number; cache_hits: number; cache_hit_ratio: number; avg_response_ms: number; p95_response_ms: number };
  series: SeriesPoint[];
  breakdowns: {
    status_codes: { code: number; count: number }[];
    countries: { country: string; requests: number; bandwidth: number }[];
    mime_types: { mime_type: string; requests: number; bandwidth: number }[];
    top_files: { id: string; name: string; downloads: number; requests: number; bandwidth: number }[];
    top_api_keys: { id: string; name: string; prefix: string; requests: number; errors: number; bandwidth: number }[];
    top_folders: { id: string | null; path: string; requests: number; bandwidth: number }[];
  };
  recent_errors: { timestamp: string; method: string; route: string; status: number; file_id: string | null; api_key_id: string | null; ip: string | null; kind: string }[];
}

interface AiCheckResult {
  enabled: boolean;
  advisory?: string | null;
  period?: string;
  privacy?: string;
  message?: string;
}

export default function AnalyticsPage() {
  const { can } = useSession();
  const [period, setPeriod] = React.useState<PeriodValue>({ period: '7d' });
  const [keyId, setKeyId] = React.useState('');
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiResult, setAiResult] = React.useState<AiCheckResult | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const keys = useQuery({ queryKey: ['api-keys', 'all'], queryFn: () => api<Paginated<ApiKeyDTO>>('/api-keys', { query: { limit: 200 } }), enabled: can('api_keys.view') });
  const aiAvailability = useQuery({ queryKey: ['ai-advisory-availability'], queryFn: () => api<AiCheckResult>('/analytics/ai-check'), enabled: can('analytics.view') });
  const q = useQuery({ queryKey: ['analytics', period, keyId], queryFn: () => api<Analytics>('/analytics', { query: { ...periodQuery(period), api_key_id: keyId || undefined } }) });
  const d = q.data;
  const hourly = d?.range.unit === 'hour';

  const totals: [string, string][] = d
    ? [
        ['Requests', formatNumber(d.totals.requests)],
        ['Downloads', formatNumber(d.totals.downloads)],
        ['Inline views', formatNumber(d.totals.views)],
        ['Share clicks', formatNumber(d.totals.clicks)],
        ['Bandwidth', formatBytes(d.totals.bandwidth)],
        ['Errors', formatNumber(d.totals.errors)],
        ['Cache revalidations', `${formatNumber(d.totals.cache_hits)} (${(d.totals.cache_hit_ratio * 100).toFixed(1)}%)`],
        ['Avg / p95 response', `${d.totals.avg_response_ms} / ${d.totals.p95_response_ms} ms`],
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Downloads: attachment transfers; views: inline file responses; clicks: share-link landings. Requests also include API traffic. Older ambiguous events are excluded from these counts. Times are UTC."
        actions={
          <>
            {can('api_keys.view') && (
              <NativeSelect value={keyId} onChange={(e) => setKeyId(e.target.value)} aria-label="Filter by API key" className="h-8 text-xs">
                <option value="">All traffic</option>
                {(keys.data?.data ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.prefix})
                  </option>
                ))}
              </NativeSelect>
            )}
            <PeriodPicker value={period} onChange={setPeriod} />
          </>
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <div className="mb-8 grid grid-cols-2 divide-x divide-y rounded-lg border md:grid-cols-4 xl:grid-cols-8">
        {(d ? totals : Array.from({ length: 8 }, () => ['', ''] as [string, string])).map(([k, v], i) => (
          <div key={i} className="px-4 py-3">
            {d ? (
              <>
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="mt-1 text-lg font-semibold tabular">{v}</div>
              </>
            ) : (
              <Skeleton className="h-10" />
            )}
          </div>
        ))}
      </div>

      {can('analytics.view') && (
        <Section title="AI operations check" description="Optional human-reviewed insights from the last 24 hours of aggregate metrics.">
          <Panel className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {aiAvailability.isLoading ? 'Checking AI availability…' : aiAvailability.isError ? 'Could not check AI configuration.' : aiAvailability.data?.enabled ? 'AI advisory is available.' : 'Configure AI_BASE_URL and AI_MODEL on the API server to enable this feature.'}
              </p>
              <Button
                size="sm"
                loading={aiBusy}
                disabled={!aiAvailability.data?.enabled}
                onClick={async () => {
                  setAiBusy(true);
                  setAiError(null);
                  setAiResult(null);
                  try {
                    setAiResult(await api<AiCheckResult>('/analytics/ai-check', { method: 'POST' }));
                  } catch (err) {
                    setAiError(errorMessage(err));
                  } finally {
                    setAiBusy(false);
                  }
                }}
              >
                Run AI check
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Only aggregate counts and storage measurements are sent to your configured AI provider when you click Run. No IPs, filenames, request bodies or file contents are sent. Advice does not change CDN settings.</p>
            {aiError && <p role="alert" className="text-sm text-destructive">{aiError}</p>}
            {aiResult?.message && <p role="status" className="text-sm text-muted-foreground">{aiResult.message}</p>}
            {aiResult?.advisory && <div role="status" className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-sm leading-relaxed">{aiResult.advisory}</div>}
          </Panel>
        </Section>
      )}

      <GeoSection period={period.period === '24h' || period.period === '7d' || period.period === '30d' ? period.period : '30d'} />
      <Section title="Over time">
        {!d ? (
          <Skeleton className="h-[460px]" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <TimeChart data={d.series} metric="requests" title="Requests" hourly={hourly} />
            <TimeChart data={d.series} metric="bandwidth" title="Bandwidth" unit="bytes" hourly={hourly} />
            <TimeChart data={d.series} metric="downloads" title="Downloads" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="views" title="Inline views" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="clicks" title="Share link clicks" hourly={hourly} kind="bar" />
            <TimeChart data={d.series} metric="cache_hits" title="Cache revalidations (304)" hourly={hourly} kind="bar" color="var(--series-3)" />
            <TimeChart data={d.series} metric="avg_ms" title="Average response time" unit="ms" hourly={hourly} color="var(--series-2)" />
            <TimeChart data={d.series} metric="errors" title="Errors (4xx/5xx)" hourly={hourly} kind="bar" color="hsl(var(--destructive))" />
          </div>
        )}
      </Section>

      {d && (
        <>
          <div className="grid gap-8 lg:grid-cols-3">
            <Section title="Status codes">
              <Panel className="p-4">
                <StatusCodeChart data={d.breakdowns.status_codes} />
              </Panel>
            </Section>
            <Section title="Countries" description="From Cloudflare headers when enabled">
              <Panel className="p-4">
                <RankedBars rows={d.breakdowns.countries.map((c) => ({ label: c.country, value: c.requests, hint: formatBytes(c.bandwidth) }))} valueLabel={formatNumber} />
              </Panel>
            </Section>
            <Section title="MIME types by bandwidth">
              <Panel className="p-4">
                <RankedBars rows={d.breakdowns.mime_types.map((m) => ({ label: m.mime_type, value: m.bandwidth }))} valueLabel={(n) => formatBytes(n)} />
              </Panel>
            </Section>
          </div>
          <div className="grid gap-8 xl:grid-cols-2">
            <Section title="Top files (bandwidth)">
              <Panel>
                {d.breakdowns.top_files.length === 0 ? (
                  <EmptyState title="No file traffic" />
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
                      {d.breakdowns.top_files.map((f) => (
                        <TR key={f.id}>
                          <TD className="max-w-[280px] truncate">
                            <Link className="hover:underline" href={`/dashboard/files?file=${f.id}`}>
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
            <Section title="Most-used API keys">
              <Panel>
                {d.breakdowns.top_api_keys.length === 0 ? (
                  <EmptyState title="No API key traffic" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <TH>Key</TH>
                        <TH className="text-right">Requests</TH>
                        <TH className="text-right">Errors</TH>
                        <TH className="text-right">Bandwidth</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {d.breakdowns.top_api_keys.map((k) => (
                        <TR key={k.id}>
                          <TD>
                            {k.name} <span className="font-mono text-xs text-muted-foreground">{k.prefix}</span>
                          </TD>
                          <TD className="text-right tabular">{formatNumber(k.requests)}</TD>
                          <TD className="text-right tabular">{formatNumber(k.errors)}</TD>
                          <TD className="text-right tabular">{formatBytes(k.bandwidth)}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>
            </Section>
            <Section title="Top folders (bandwidth)">
              <Panel className="p-4">
                <RankedBars rows={d.breakdowns.top_folders.map((f) => ({ label: f.path, value: f.bandwidth, hint: `${f.requests} requests` }))} valueLabel={(n) => formatBytes(n)} />
              </Panel>
            </Section>
            <Section title="Recent errors">
              <Panel>
                {d.recent_errors.length === 0 ? (
                  <EmptyState title="No errors in this period" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <TH>Time</TH>
                        <TH>Status</TH>
                        <TH>Request</TH>
                        <TH>IP</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {d.recent_errors.map((e, i) => (
                        <TR key={i}>
                          <TD className="whitespace-nowrap text-muted-foreground">{formatDate(e.timestamp)}</TD>
                          <TD>
                            <Badge tone={e.status >= 500 ? 'danger' : 'warning'}>{e.status}</Badge>
                          </TD>
                          <TD className="font-mono text-xs">
                            {e.method} {e.route}
                          </TD>
                          <TD className="font-mono text-xs text-muted-foreground">{e.ip ?? '—'}</TD>
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
    </>
  );
}

function GeoSection({ period }: { period: '24h' | '7d' | '30d' }) {
  const geo = useQuery({ queryKey: ['geo', period], queryFn: () => api<GeoData>('/analytics/geo', { query: { period } }), refetchInterval: 60_000 });
  return (
    <Section title="Global delivery" description="Visitors by country with live flows from storage origins. Hover a country for details.">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Panel className="p-3">{geo.data ? <DeliveryMap data={geo.data} /> : <Skeleton className="aspect-[2/1] w-full" />}</Panel>
        <Panel className="max-h-[520px] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-subtle text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Country</th>
                <th className="px-3 py-2 text-right font-medium">Requests</th>
                <th className="px-3 py-2 text-right font-medium">Bandwidth</th>
              </tr>
            </thead>
            <tbody>
              {geo.data?.countries.map((c) => (
                <tr key={c.country} className="border-t">
                  <td className="px-3 py-1.5">{countryName(c.country)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{formatNumber(c.requests)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{formatBytes(c.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {geo.data && geo.data.countries.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">No delivery traffic in this period.</p>}
        </Panel>
      </div>
    </Section>
  );
}
