'use client';
import { CheckCircle2, Loader2, RotateCcw, X, XCircle, Clock } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/misc';
import { useUploads, type UploadItem } from './upload-manager';

const STATUS: Record<UploadItem['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  uploading: { label: 'Uploading', tone: 'info' },
  processing: { label: 'Processing', tone: 'warning' },
  complete: { label: 'Complete', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function StatusIcon({ status }: { status: UploadItem['status'] }) {
  if (status === 'complete') return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === 'queued' || status === 'cancelled') return <Clock className="h-4 w-4 text-muted-foreground" />;
  return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
}

export function UploadList({ compact = false }: { compact?: boolean }) {
  const { items, retry, cancel } = useUploads();
  if (!items.length) return null;
  return (
    <ul className="divide-y">
      {items.map((it) => {
        const pct = it.file.size ? Math.round((it.loaded / it.file.size) * 100) : 100;
        const s = STATUS[it.status];
        return (
          <li key={it.id} className={cn('flex items-center gap-3 px-3', compact ? 'py-2' : 'py-2.5')}>
            <StatusIcon status={it.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium" title={it.file.name}>
                  {it.file.name}
                </span>
                <Badge tone={s.tone}>{s.label}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground tabular">
                <span>{formatBytes(it.file.size)}</span>
                {!compact && <span className="truncate">→ {it.folderLabel}</span>}
                {it.status === 'uploading' && (
                  <>
                    <span>{pct}%</span>
                    <span>{formatBytes(it.speed)}/s</span>
                  </>
                )}
                {it.error && it.status === 'failed' && <span className="truncate text-destructive">{it.error}</span>}
              </div>
              {(it.status === 'uploading' || it.status === 'processing') && (
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
                  <div className={cn('h-full bg-primary transition-[width]', it.status === 'processing' && 'animate-pulse')} style={{ width: `${it.status === 'processing' ? 100 : pct}%` }} />
                </div>
              )}
            </div>
            {(it.status === 'failed' || it.status === 'cancelled') && (
              <Button size="xs" variant="secondary" onClick={() => retry(it.id)}>
                <RotateCcw /> Retry
              </Button>
            )}
            {(it.status === 'queued' || it.status === 'uploading') && (
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Cancel upload" onClick={() => cancel(it.id)}>
                <X />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
