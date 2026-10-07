'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, UserPlus, Users as UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { RoleDTO, UserDTO } from '@/lib/types';
import { formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, NativeSelect, Switch, Label } from '@/components/ui/form';
import { Badge, CopyButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm, useStepUp } from '@/components/confirm';

function RolePicker({ roles, value, onChange }: { roles: RoleDTO[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border p-2">
      {roles.map((r) => (
        <label key={r.id} className="flex items-start gap-2 text-[13px]">
          <Checkbox className="mt-0.5" checked={value.includes(r.id)} onCheckedChange={(c) => onChange(c === true ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span>
            {r.name}
            <span className="block text-[11px] text-muted-foreground">{r.permissions.length} permissions</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function LinkDialog({ link, onClose, title }: { link: { url: string; expires_at: string } | null; onClose: () => void; title: string }) {
  return (
    <Dialog open={Boolean(link)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={title} description="Share this one-time link with the user over a secure channel. It is shown only once." />
        <DialogBody>
          <code className="block break-all rounded-md border bg-subtle p-2 text-xs">{link?.url}</code>
          <p className="text-xs text-muted-foreground">Expires {link ? formatDate(link.expires_at) : ''}</p>
          {link && (
            <CopyButton value={link.url} label="Link copied">
              Copy link
            </CopyButton>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const { can, session } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserDTO | null>(null);
  const [link, setLink] = React.useState<{ url: string; expires_at: string; title: string } | null>(null);

  const q = useQuery({ queryKey: ['users', search, status, page], queryFn: () => api<Paginated<UserDTO>>('/users', { query: { q: search || undefined, status: status || undefined, page, limit: 50 } }) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: RoleDTO[] }>('/roles'), enabled: can('roles.view') || can('users.edit') });

  // Create form state
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [mode, setMode] = React.useState<'invite' | 'password'>('invite');
  const [password, setPassword] = React.useState('');
  const [roleIds, setRoleIds] = React.useState<string[]>([]);
  const [require2fa, setRequire2fa] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Edit form state
  const [editName, setEditName] = React.useState('');
  const [editRoles, setEditRoles] = React.useState<string[]>([]);
  const [edit2fa, setEdit2fa] = React.useState(false);
  React.useEffect(() => {
    if (editing) {
      setEditName(editing.name);
      setEditRoles(editing.roles.map((r) => r.id));
      setEdit2fa(editing.require_two_factor);
      setError(null);
    }
  }, [editing]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Staff accounts with access to this dashboard."
        actions={
          can('users.create') && (
            <Button
              onClick={() => {
                setEmail('');
                setName('');
                setPassword('');
                setRoleIds([]);
                setRequire2fa(false);
                setError(null);
                setCreateOpen(true);
              }}
            >
              <UserPlus /> Add staff
            </Button>
          )
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search name or email…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        <NativeSelect value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Status">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INVITED">Invited</option>
          <option value="DISABLED">Disabled</option>
        </NativeSelect>
      </div>
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Panel>
        {q.isLoading ? (
          <Skeleton className="m-3 h-48" />
        ) : !q.data?.data.length ? (
          <EmptyState icon={UsersIcon} title="No users found" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Roles</TH>
                <TH>Status</TH>
                <TH>2FA</TH>
                <TH>Last login</TH>
                <TH>Created</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {q.data.data.map((u) => (
                <TR key={u.id}>
                  <TD className="font-medium">
                    {u.name}
                    {u.id === session.user.id && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                  </TD>
                  <TD className="text-muted-foreground">{u.email}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length ? u.roles.map((r) => <Badge key={r.id}>{r.name}</Badge>) : <span className="text-xs text-muted-foreground">None</span>}
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={u.status === 'ACTIVE' ? 'success' : u.status === 'INVITED' ? 'info' : 'danger'}>{u.status.toLowerCase()}</Badge>
                  </TD>
                  <TD>{u.two_factor_enabled ? <Badge tone="success">On</Badge> : u.require_two_factor ? <Badge tone="warning">Required</Badge> : <Badge>Off</Badge>}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground" title={u.last_login_ip ?? ''}>
                    {timeAgo(u.last_login_at)}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDate(u.created_at, false)}</TD>
                  <TD>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="User actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {can('users.edit') && <DropdownMenuItem onSelect={() => setEditing(u)}>Edit roles & settings</DropdownMenuItem>}
                        {can('users.edit') && (
                          <DropdownMenuItem
                            onSelect={() =>
                              void stepUp(async () => {
                                const l = await api<{ url: string; expires_at: string }>(`/users/${u.id}/reset-password`, { method: 'POST' });
                                setLink({ ...l, title: u.status === 'INVITED' ? 'Invitation link' : 'Password reset link' });
                              })
                            }
                          >
                            {u.status === 'INVITED' ? 'Re-send invitation link' : 'Reset password'}
                          </DropdownMenuItem>
                        )}
                        {can('users.edit') && u.two_factor_enabled && (
                          <DropdownMenuItem
                            onSelect={() =>
                              confirm({
                                title: `Reset 2FA for ${u.name}?`,
                                description: 'Their authenticator and recovery codes are removed and all sessions revoked.',
                                requireReauth: true,
                                destructive: true,
                                confirmLabel: 'Reset 2FA',
                                successMessage: '2FA reset',
                                action: async () => {
                                  await api(`/users/${u.id}/reset-2fa`, { method: 'POST' });
                                  refresh();
                                },
                              })
                            }
                          >
                            Reset 2FA
                          </DropdownMenuItem>
                        )}
                        {can('users.disable') && (
                          <DropdownMenuItem onSelect={() => void run(() => api<{ revoked: number }>(`/users/${u.id}/sessions`, { method: 'DELETE' }), 'Sessions revoked')}>Revoke sessions</DropdownMenuItem>
                        )}
                        {can('users.disable') && u.id !== session.user.id && (
                          <>
                            <DropdownMenuSeparator />
                            {u.status === 'DISABLED' ? (
                              <DropdownMenuItem onSelect={() => void run(() => api(`/users/${u.id}/enable`, { method: 'POST' }), 'User enabled')}>Enable</DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                destructive
                                onSelect={() =>
                                  confirm({
                                    title: `Disable ${u.name}?`,
                                    description: 'They will be signed out everywhere and cannot sign in until re-enabled.',
                                    destructive: true,
                                    confirmLabel: 'Disable user',
                                    successMessage: 'User disabled',
                                    action: async () => {
                                      await api(`/users/${u.id}/disable`, { method: 'POST' });
                                      refresh();
                                    },
                                  })
                                }
                              >
                                Disable
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              destructive
                              onSelect={() =>
                                confirm({
                                  title: `Delete ${u.name}?`,
                                  description: 'The account is permanently deleted. Their files and audit history are kept.',
                                  destructive: true,
                                  typeToConfirm: u.email,
                                  requireReauth: true,
                                  confirmLabel: 'Delete user',
                                  successMessage: 'User deleted',
                                  action: async () => {
                                    await api(`/users/${u.id}`, { method: 'DELETE' });
                                    refresh();
                                  },
                                })
                              }
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {q.data && <Pagination page={page} totalPages={q.data.pagination.total_pages} total={q.data.pagination.total} onPage={setPage} />}
      </Panel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="lg">
          <DialogHeader title="Add staff member" />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const res = await api<{ invite_url: string | null; invite_expires_at: string | null }>('/users', {
                  body: { email, name, role_ids: roleIds, require_two_factor: require2fa, invite: mode === 'invite', ...(mode === 'password' ? { password } : {}) },
                });
                setCreateOpen(false);
                refresh();
                if (res.invite_url) setLink({ url: res.invite_url, expires_at: res.invite_expires_at!, title: 'Invitation link' });
                else toast.success('User created');
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
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </Field>
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
              </div>
              <Field label="Account setup">
                <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as 'invite' | 'password')}>
                  <option value="invite">Generate an invitation link (recommended)</option>
                  <option value="password">Set an initial password</option>
                </NativeSelect>
              </Field>
              {mode === 'password' && (
                <Field label="Initial password" hint="Min. 12 characters; three of lowercase, uppercase, digits, symbols.">
                  <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
              )}
              {can('users.edit') && roles.data && (
                <Field label="Roles">
                  <RolePicker roles={roles.data.data} value={roleIds} onChange={setRoleIds} />
                </Field>
              )}
              <div className="flex items-center justify-between">
                <Label>Require two-factor authentication</Label>
                <Switch checked={require2fa} onCheckedChange={setRequire2fa} />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                <Plus /> Add staff
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent size="lg">
          <DialogHeader title={`Edit ${editing?.name ?? ''}`} description={editing?.email} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await api(`/users/${editing!.id}`, { method: 'PATCH', body: { name: editName, role_ids: editRoles, require_two_factor: edit2fa } });
                toast.success('User updated');
                setEditing(null);
                refresh();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogBody>
              <Field label="Name">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </Field>
              {roles.data && (
                <Field label="Roles" hint="You can only assign roles whose permissions you hold.">
                  <RolePicker roles={roles.data.data} value={editRoles} onChange={setEditRoles} />
                </Field>
              )}
              <div className="flex items-center justify-between">
                <Label>Require two-factor authentication</Label>
                <Switch checked={edit2fa} onCheckedChange={setEdit2fa} />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <LinkDialog link={link} title={link?.title ?? ''} onClose={() => setLink(null)} />
    </>
  );
}
