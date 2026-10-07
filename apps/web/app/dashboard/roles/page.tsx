'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, PERMISSION_GROUPS, type Permission } from '@cdn/shared/permissions';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { RoleDTO } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Badge, ErrorState, PageHeader, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { useConfirm } from '@/components/confirm';
import { cn } from '@/lib/utils';

export default function RolesPage() {
  const { can, session } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: RoleDTO[] }>('/roles') });
  const [editing, setEditing] = React.useState<RoleDTO | 'new' | null>(null);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [perms, setPerms] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const manage = can('roles.manage');

  React.useEffect(() => {
    if (editing === 'new') {
      setName('');
      setDescription('');
      setPerms([]);
    } else if (editing) {
      setName(editing.name);
      setDescription(editing.description);
      setPerms(editing.permissions);
    }
    setError(null);
  }, [editing]);

  const readOnly = editing !== 'new' && (editing?.locked || !manage);

  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles bundle granular permissions. Access is always enforced by the server — hiding a button never grants or removes access."
        actions={
          manage && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Create role
            </Button>
          )
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <Panel className="divide-y">
          {q.data?.data.map((r) => (
            <button key={r.id} type="button" onClick={() => setEditing(r)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-subtle">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  {r.locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                  {r.system ? <Badge>Built-in</Badge> : <Badge tone="info">Custom</Badge>}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{r.description || '—'}</p>
              </div>
              <span className="text-xs text-muted-foreground tabular">{r.permissions.length} permissions</span>
              <span className="w-20 text-right text-xs text-muted-foreground tabular">{r.user_count} users</span>
            </button>
          ))}
        </Panel>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent size="xl">
          <DialogHeader title={editing === 'new' ? 'Create role' : (editing?.name ?? '')} description={editing && editing !== 'new' && editing.locked ? 'This role always has every permission and cannot be modified.' : undefined} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                if (editing === 'new') await api('/roles', { body: { name, description, permissions: perms } });
                else await api(`/roles/${editing!.id}`, { method: 'PATCH', body: { ...(editing!.system ? {} : { name }), description, permissions: perms } });
                toast.success('Role saved');
                void qc.invalidateQueries({ queryKey: ['roles'] });
                void qc.invalidateQueries({ queryKey: ['session'] });
                setEditing(null);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogBody>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly || (editing !== 'new' && editing?.system)} required />
                </Field>
                <Field label="Description">
                  <Textarea className="min-h-[36px]" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {PERMISSION_GROUPS.map((g) => (
                  <fieldset key={g.label} className="rounded-md border p-3">
                    <legend className="px-1 text-xs font-semibold text-muted-foreground">{g.label}</legend>
                    <div className="space-y-2">
                      {g.permissions.map((p: Permission) => {
                        const held = session.permissions.includes(p);
                        return (
                          <label key={p} className={cn('flex items-start gap-2', !held && !readOnly && 'opacity-60')} title={!held ? 'You cannot grant a permission you do not hold' : undefined}>
                            <Checkbox className="mt-0.5" disabled={readOnly || !held} checked={perms.includes(p)} onCheckedChange={(c) => setPerms((prev) => (c === true ? [...prev, p] : prev.filter((x) => x !== p)))} />
                            <span>
                              <span className="block font-mono text-xs">{p}</span>
                              <span className="block text-[11px] text-muted-foreground">{PERMISSIONS[p]}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              {editing && editing !== 'new' && !editing.system && manage && (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto text-destructive"
                  onClick={() =>
                    confirm({
                      title: `Delete role ${editing.name}?`,
                      description: `${editing.user_count} user(s) will lose this role.`,
                      destructive: true,
                      requireReauth: true,
                      confirmLabel: 'Delete role',
                      successMessage: 'Role deleted',
                      action: async () => {
                        await api(`/roles/${editing.id}`, { method: 'DELETE' });
                        void qc.invalidateQueries({ queryKey: ['roles'] });
                        setEditing(null);
                      },
                    })
                  }
                >
                  Delete role
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                {readOnly ? 'Close' : 'Cancel'}
              </Button>
              {!readOnly && (
                <Button type="submit" loading={busy}>
                  Save role
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
