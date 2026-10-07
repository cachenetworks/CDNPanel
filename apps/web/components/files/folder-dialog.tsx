'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { VISIBILITIES, type FolderDTO, type RoleDTO, type Visibility } from '@/lib/types';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox, Field, Input, NativeSelect } from '../ui/form';

/** Create or edit a folder: name, default visibility and role restrictions. */
export function FolderDialog({ open, onOpenChange, parentId, folder }: { open: boolean; onOpenChange: (o: boolean) => void; parentId?: string | null; folder?: FolderDTO | null }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [name, setName] = React.useState('');
  const [visibility, setVisibility] = React.useState<Visibility | ''>('');
  const [roles, setRoles] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const rolesQ = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: RoleDTO[] }>('/roles'), enabled: open && can('roles.manage') });

  React.useEffect(() => {
    if (open) {
      setName(folder?.name ?? '');
      setVisibility(folder?.visibility ?? '');
      setRoles(folder?.restricted_to_role_ids ?? []);
      setError(null);
    }
  }, [open, folder]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, visibility: visibility || null };
      if (can('roles.manage')) body.restricted_to_role_ids = roles;
      if (folder) await api(`/folders/${folder.id}`, { method: 'PATCH', body });
      else await api('/folders', { body: { ...body, parent_id: parentId ?? null } });
      toast.success(folder ? 'Folder updated' : 'Folder created');
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['folder'] });
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={folder ? 'Edit folder' : 'New folder'} />
        <form onSubmit={submit}>
          <DialogBody>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={255} />
            </Field>
            <Field label="Default visibility for new files" hint="Inherited by sub-folders unless they set their own.">
              <NativeSelect className="w-full" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility | '')}>
                <option value="">Inherit</option>
                {VISIBILITIES.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label} — {v.description}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {can('roles.manage') && (
              <Field label="Restrict staff access to roles" hint="Leave empty for no restriction. Administrators always have access. API keys are governed by their scopes.">
                <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto rounded-md border p-2">
                  {(rolesQ.data?.data ?? []).map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-[13px]">
                      <Checkbox checked={roles.includes(r.id)} onCheckedChange={(c) => setRoles((prev) => (c === true ? [...prev, r.id] : prev.filter((x) => x !== r.id)))} />
                      {r.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {folder ? 'Save' : 'Create folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
