'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { Button } from '../ui/button';
import { Field, NativeSelect } from '../ui/form';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';

type Destination = { id: string; name: string; kind: string; enabled: boolean; health_status: string };

export function StorageMoveDialog({ open, onOpenChange, fileIds, currentProviderId, onMoved }: {
  open: boolean; onOpenChange: (open: boolean) => void; fileIds: string[]; currentProviderId?: string; onMoved?: () => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState('');
  const q = useQuery({ queryKey: ['storage-move-providers'], queryFn: () => api<{ data: Destination[] }>('/storage/providers'), enabled: open });
  const destinations = (q.data?.data ?? []).filter((p) => p.enabled && p.id !== currentProviderId && p.health_status !== 'unhealthy');
  React.useEffect(() => { if (open) { setTarget(''); setProgress(''); } }, [open]);
  const move = async () => {
    setBusy(true);
    let moved = 0;
    const failures: string[] = [];
    for (const [index, id] of fileIds.entries()) {
      setProgress(`Moving file ${index + 1} of ${fileIds.length}…`);
      try {
        await api(`/files/${id}/move-storage`, { body: { storage_provider_id: target } });
        moved++;
      } catch (err) { failures.push(`${id}: ${errorMessage(err)}`); }
    }
    setBusy(false);
    if (moved) {
      toast.success(`${moved} file${moved === 1 ? '' : 's'} moved`);
      for (const key of ['files', 'file', 'storage', 'storage-move-providers']) void qc.invalidateQueries({ queryKey: [key] });
      onMoved?.();
    }
    if (failures.length) setProgress(`${failures.length} failed. ${failures.join(' ')}`);
    else onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent>
      <DialogHeader title="Move storage" description="Move files to another server, storage pool or cloud bucket, including Backblaze B2." />
      <DialogBody>
        <p className="text-sm text-muted-foreground">File URLs stay the same. The current content is verified before switching storage. Revisions, derived media and configured replicas keep their own locations. Remote servers must belong to a pool.</p>
        <Field label="Destination">
          <NativeSelect className="w-full" value={target} disabled={busy || q.isPending} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select a destination</option>
            {destinations.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.kind}</option>)}
          </NativeSelect>
        </Field>
        {q.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(q.error)}</p>}
        {q.isSuccess && !destinations.length && <p className="text-sm text-muted-foreground">No other available destinations. Add or enable a provider or pool in Storage.</p>}
        {progress && <p role="status" className="break-words text-sm">{progress}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={busy || !destinations.some((p) => p.id === target)} onClick={() => void move()}>{busy ? 'Moving…' : `Move ${fileIds.length === 1 ? 'file' : `${fileIds.length} files`}`}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
