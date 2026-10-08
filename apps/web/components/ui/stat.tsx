import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input, Textarea } from './form';

export function StatGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 divide-x divide-y rounded-lg border sm:grid-cols-3 lg:grid-cols-6 [&>*]:border-border', className)}>{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Status dot + label (never colour alone). */
export function StatusDot({ status, label }: { status: 'ok' | 'warn' | 'fail' | 'idle'; label: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span
        aria-hidden
        className={cn('h-2 w-2 shrink-0 rounded-full', {
          ok: 'bg-[hsl(var(--success))]',
          warn: 'bg-[hsl(var(--warning))]',
          fail: 'bg-destructive',
          idle: 'bg-muted-foreground/40',
        }[status])}
      />
      {label}
    </span>
  );
}

export function healthTone(h: string | null | undefined): 'ok' | 'warn' | 'fail' | 'idle' {
  if (h === 'healthy' || h === 'active' || h === 'ACTIVE' || h === 'SYNCED' || h === 'READY') return 'ok';
  if (h === 'unhealthy' || h === 'error' || h === 'FAILED' || h === 'MISSING') return 'fail';
  if (h === 'PENDING' || h === 'PROCESSING') return 'warn';
  return 'idle';
}

/** Comma / newline separated list editor backed by a string[]. */
export function ListInput({ value, onChange, placeholder, multiline, upper }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; multiline?: boolean; upper?: boolean }) {
  const [text, setText] = React.useState(value.join(multiline ? '\n' : ', '));
  React.useEffect(() => setText(value.join(multiline ? '\n' : ', ')), [value, multiline]);
  const commit = (t: string) =>
    onChange(
      t
        .split(/[\n,]/)
        .map((s) => (upper ? s.trim().toUpperCase() : s.trim()))
        .filter(Boolean),
    );
  return multiline ? (
    <Textarea value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} rows={3} className="font-mono text-xs" />
  ) : (
    <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} />
  );
}

export function formatTtl(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds === 0) return 'no cache';
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export const TTL_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'Do not cache' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 14_400, label: '4 hours' },
  { value: 86_400, label: '1 day' },
  { value: 604_800, label: '7 days' },
  { value: 2_592_000, label: '30 days' },
  { value: 31_536_000, label: '1 year' },
];
