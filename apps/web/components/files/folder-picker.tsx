'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Paginated } from '@/lib/api';
import type { FolderDTO } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Skeleton } from '../ui/misc';
import { FolderIcon } from './file-icon';

/** Lists all folders as an indented tree to pick a destination. */
export function FolderPickerDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  excludeSubtreeOf,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  confirmLabel: string;
  excludeSubtreeOf?: string;
  onPick: (folderId: string | null) => Promise<void>;
}) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const q = useQuery({ queryKey: ['folders', 'all'], queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { all: 'true', limit: 500 } }), enabled: open });
  const folders = (q.data?.data ?? []).filter((f) => !excludeSubtreeOf || (f.path !== excludeSubtreeOf && !f.path.startsWith(`${excludeSubtreeOf}/`))).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={title} />
        <DialogBody>
          <Input placeholder="Filter folders…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <button type="button" onClick={() => setSelected(null)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent', selected === null && 'bg-accent font-medium')}>
              <FolderIcon /> / (root)
            </button>
            {q.isLoading && <Skeleton className="m-3 h-20" />}
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelected(f.id)}
                style={{ paddingLeft: 12 + (f.path.split('/').length - 2) * 16 }}
                className={cn('flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[13px] hover:bg-accent', selected === f.id && 'bg-accent font-medium')}
              >
                <FolderIcon /> <span className="truncate">{f.name}</span>
                <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{f.path}</span>
              </button>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(selected);
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
