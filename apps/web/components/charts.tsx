'use client';
import * as React from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn, formatBytes, formatNumber } from '@/lib/utils';
import type { SeriesPoint } from '@/lib/types';
import { Button } from './ui/button';
import { Input } from './ui/form';

export type Period = '24h' | '7d' | '30d' | '90d' | 'custom';
export interface PeriodValue {
  period: Period;
  from?: string;
  to?: string;
}

export function periodQuery(p: PeriodValue) {
  return p.period === 'custom' ? { period: 'custom', from: p.from ? new Date(p.from).toISOString() : undefined, to: p.to ? new Date(p.to).toISOString() : undefined } : { period: p.period };
}

/** Time-range filter: presets plus a custom from/to range, in one row. */
export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const [from, setFrom] = React.useState(value.from ?? '');
  const [to, setTo] = React.useState(value.to ?? '');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border p-0.5">
        {(['24h', '7d', '30d', '90d', 'custom'] as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => (p === 'custom' ? onChange({ period: 'custom', from, to }) : onChange({ period: p }))}
            className={cn('rounded px-2.5 py-1 text-xs font-medium text-muted-foreground', value.period === p && 'bg-accent text-foreground')}
          >
            {p === 'custom' ? 'Custom' : p}
          </button>
        ))}
      </div>
      {value.period === 'custom' && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onChange({ period: 'custom', from, to });
          }}
        >
          <Input type="datetime-local" className="h-8 w-auto text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="datetime-local" className="h-8 w-auto text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          <Button size="sm" variant="secondary" type="submit" disabled={!from || !to}>
            Apply
          </Button>
        </form>
      )}
    </div>
  );
}

const tickStyle = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

function formatTick(t: string, hourly: boolean) {
  const d = new Date(t);
  return hourly ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type Metric = keyof Omit<SeriesPoint, 't'>;

function ChartTooltip({ active, payload, label, hourly, format, name }: { active?: boolean; payload?: { value: number }[]; label?: string; hourly: boolean; format: (n: number) => string; name: string }) {
  if (!active || !payload?.length || !label) return null;
  const d = new Date(label);
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <div className="text-muted-foreground">{hourly ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' })}</div>
      <div className="mt-0.5 font-medium tabular text-foreground">
        {format(payload[0]!.value)} <span className="font-normal text-muted-foreground">{name}</span>
      </div>
    </div>
  );
}

/** Single-series time chart (one measure per chart — no dual axes). */
export function TimeChart({
  data,
  metric,
  title,
  unit,
  hourly,
  kind = 'area',
  color = 'var(--series-1)',
  height = 180,
}: {
  data: SeriesPoint[];
  metric: Metric;
  title: string;
  unit?: 'bytes' | 'ms';
  hourly: boolean;
  kind?: 'area' | 'bar';
  color?: string;
  height?: number;
}) {
  const format = unit === 'bytes' ? (n: number) => formatBytes(n) : unit === 'ms' ? (n: number) => `${n} ms` : (n: number) => formatNumber(n);
  const total = data.reduce((s, p) => s + (p[metric] as number), 0);
  const id = React.useId().replace(/:/g, '');
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        {unit !== 'ms' && <span className="text-sm font-semibold tabular">{format(total)}</span>}
      </div>
      <div style={{ height }} role="img" aria-label={`${title} over time`}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'area' ? (
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis dataKey="t" tickFormatter={(t) => formatTick(t, hourly)} tick={tickStyle} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tickFormatter={(v) => (unit === 'bytes' ? formatBytes(v, 0) : formatNumber(v))} tick={tickStyle} axisLine={false} tickLine={false} width={56} />
              <Tooltip cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} content={<ChartTooltip hourly={hourly} format={format} name={title.toLowerCase()} />} />
              <Area type="monotone" dataKey={metric} stroke={color} strokeWidth={2} fill={`url(#g${id})`} activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--background))' }} />
            </AreaChart>
          ) : (
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis dataKey="t" tickFormatter={(t) => formatTick(t, hourly)} tick={tickStyle} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tickFormatter={(v) => formatNumber(v)} tick={tickStyle} axisLine={false} tickLine={false} width={56} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} content={<ChartTooltip hourly={hourly} format={format} name={title.toLowerCase()} />} />
              <Bar dataKey={metric} fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** HTTP status code distribution: bars grouped by class, labelled (never color alone). */
export function StatusCodeChart({ data }: { data: { code: number; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return <p className="py-8 text-center text-sm text-muted-foreground">No requests in this period.</p>;
  const tone = (c: number) => (c >= 500 ? 'hsl(var(--destructive))' : c >= 400 ? 'hsl(var(--warning))' : c >= 300 ? 'var(--series-1)' : 'hsl(var(--success))');
  const sorted = [...data].sort((a, b) => b.count - a.count).slice(0, 8);
  return (
    <ul className="space-y-2">
      {sorted.map((d) => (
        <li key={d.code} className="grid grid-cols-[44px_1fr_64px] items-center gap-3 text-[13px]">
          <span className="font-mono text-xs">{d.code}</span>
          <div className="h-2 overflow-hidden rounded bg-muted" title={`${d.count.toLocaleString()} responses`}>
            <div className="h-full rounded" style={{ width: `${Math.max(1, (d.count / sorted[0]!.count) * 100)}%`, background: tone(d.code) }} />
          </div>
          <span className="text-right tabular text-muted-foreground">{((d.count / total) * 100).toFixed(1)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Horizontal ranked bars for breakdowns (country, MIME type, ...). */
export function RankedBars({ rows, valueLabel }: { rows: { label: string; value: number; hint?: string }[]; valueLabel: (n: number) => string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No data for this period.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <BarChartFallback rows={rows} max={max} valueLabel={valueLabel} />
  );
}

function BarChartFallback({ rows, max, valueLabel }: { rows: { label: string; value: number; hint?: string }[]; max: number; valueLabel: (n: number) => string }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-[13px]" title={r.hint}>
          <div className="mb-1 flex justify-between gap-3">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 tabular text-muted-foreground">{valueLabel(r.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-muted">
            <div className="h-full rounded bg-[var(--series-1)]" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export { Cell };
