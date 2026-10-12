'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { Button } from '../ui/button';
import { Field, NativeSelect } from '../ui/form';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';

interface Move {
  id: string;
  state: string;
  target_name: string;
  error: string | null;
  progress: {
    total: number; processed: number; moved: number; failed: number; skipped: number; current_file: string | null;
    failures: { id: string; name: string; error: string }[];
  };
}
interface Destination { id: string; name: string; kind: string; enabled: boolean; health_status: string }
const running = (move: Move) => !['completed', 'failed'].includes(move.state);

export function LocalStorageMove() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const moves = useQuery({
    queryKey: ['local-storage-moves'], queryFn: () => api<{ data: Move[] }>('/storage/local-moves'),
    refetchInterval: (query) => query.state.data?.data.some(running) ? 2000 : 10000,
  });
  const preview = useQuery({ queryKey: ['local-storage-move-preview'], queryFn: () => api<{ count: number; bytes: number; not_ready: number }>('/storage/local-move-preview'), enabled: open });
  const providers = useQuery({ queryKey: ['local-storage-move-providers'], queryFn: () => api<{ data: Destination[] }>('/storage/providers'), enabled: open });
  const destinations = (providers.data?.data ?? []).filter((p) => p.enabled && p.kind !== 'LOCAL' && p.health_status !== 'unhealthy');
  const active = moves.data?.data.some(running) ?? false;
  const completed = moves.data?.data.filter((m) => m.state === 'completed').map((m) => m.id).join(',');
  React.useEffect(() => {
    if (completed) for (const key of ['storage', 'files', 'file', 'local-storage-move-preview']) void qc.invalidateQueries({ queryKey: [key] });
  }, [completed, qc]);
  const start = async () => {
    setBusy(true);
    try {
      const result = await api<{ total: number }>('/storage/local-moves', { body: { storage_provider_id: target } });
      toast.success(`Queued ${result.total} local files to move`);
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ['local-storage-moves'] });
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="mb-6 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-semibold">Move all local files</h3><p className="text-sm text-muted-foreground">Transfer files from local storage to Backblaze B2, another cloud provider or a pool.</p></div>
        <Button variant="secondary" disabled={active || moves.isPending || moves.isError} onClick={() => {
          setTarget(destinations.find((p) => p.kind === 'B2')?.id ?? '');
          setOpen(true);
          void preview.refetch();
          void providers.refetch();
        }}>{active ? 'Move in progress' : 'Move all local files'}</Button>
      </div>
      {moves.isError && <p role="alert" className="mt-2 text-sm text-destructive">{errorMessage(moves.error)}</p>}
      {moves.data?.data.map((move) => <div key={move.id} className="mt-4 border-t pt-3 text-sm">
        <div className="flex justify-between gap-3"><span className="font-medium">{move.target_name}</span><span>{move.state === 'completed' ? (move.progress.failed ? 'Finished with errors' : 'Finished') : move.state}</span></div>
        <progress className="mt-2 h-2 w-full" max={Math.max(1, move.progress.total)} value={move.progress.processed} aria-label={`Move to ${move.target_name}`} />
        <p>{move.progress.processed} / {move.progress.total} processed · {move.progress.moved} moved · {move.progress.failed} failed · {move.progress.skipped} skipped</p>
        {move.progress.current_file && running(move) && <p className="truncate text-muted-foreground">Moving {move.progress.current_file}</p>}
        {move.error && move.state === 'failed' && <p role="alert" className="text-destructive">{move.error}</p>}
        {move.progress.failures.length > 0 && <details className="mt-2"><summary className="cursor-pointer">Failed files (up to 100 shown)</summary>
          <ul className="mt-2 space-y-1">{move.progress.failures.map((f) => <li key={f.id} className="break-words">{f.name}: {f.error}</li>)}</ul>
          <p className="mt-2 text-muted-foreground">Fix the reported problems and start another move to retry files still on local storage.</p>
        </details>}
      </div>)}
    </div>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader title="Move all local files" description="Move every ready local file across all folders in the background." />
        <DialogBody>
          {preview.data && <p className="font-medium">{preview.data.count.toLocaleString()} files · {formatBytes(preview.data.bytes)}</p>}
          <p className="text-sm text-muted-foreground">URLs stay the same. You can close the page while the move runs. Each file is verified before its storage location changes.</p>
          <p className="text-sm text-muted-foreground">Previous revisions, generated media and recycle-bin files keep their existing storage and may still use local disk. Future uploads continue using your configured default.</p>
          {Boolean(preview.data?.not_ready) && <p className="text-sm text-muted-foreground">{preview.data?.not_ready} files are not ready and will be skipped.</p>}
          <Field label="Destination">
            <NativeSelect className="w-full" value={target} disabled={busy || providers.isPending} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Select B2 or another destination</option>
              {destinations.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.kind === 'B2' ? 'Backblaze B2' : p.kind}</option>)}
            </NativeSelect>
          </Field>
          {providers.isSuccess && !destinations.length && <p className="text-sm">Add or enable a B2 provider or pool in Storage first.</p>}
          {(preview.isError || providers.isError) && <p role="alert" className="text-sm text-destructive">{errorMessage(preview.error ?? providers.error)}</p>}
        </DialogBody>
        <DialogFooter><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy || active || !preview.data?.count || !destinations.some((p) => p.id === target)} onClick={() => void start()}>{busy ? 'Starting…' : 'Start move'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
