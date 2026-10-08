'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Plus, RotateCw, Ban, Power, Pencil, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { API_SCOPES, type ApiScope } from '@cdn/shared/permissions';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ApiKeyDTO } from '@/lib/types';
import { formatDate, formatNumber, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, KeyValue, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { CreateKeyDialog, RevealKeyDialog } from '@/components/api-keys/create-key';
import { useConfirm } from '@/components/confirm';

const STATUS_TONE = { active: 'success', disabled: 'neutral', revoked: 'danger', expired: 'warning', suspended: 'danger' } as const;

function EditKeyDialog({ apiKey, onClose }: { apiKey: ApiKeyDTO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['api-key', apiKey?.id], queryFn: () => api<ApiKeyDTO>(`/api-keys/${apiKey!.id}`), enabled: Boolean(apiKey) });
  const [name, setName] = React.useState('');
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [ips, setIps] = React.useState('');
  const [endpoints, setEndpoints] = React.useState('');
  const [rateLimit, setRateLimit] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const k = detail.data;
    if (k) {
      setName(k.name);
      setScopes(k.scopes);
      setIps(k.ip_restrictions.join('\n'));
      setEndpoints(k.allowed_endpoints.join('\n'));
      setRateLimit(k.rate_limit ? String(k.rate_limit) : '');
      setExpiresAt(k.expires_at ? k.expires_at.slice(0, 16) : '');
      setNotes(k.notes ?? '');
      setError(null);
    }
  }, [detail.data]);

  const split = (s: string) =>
    s
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={`Edit ${apiKey?.name ?? 'API key'}`} description={apiKey?.masked_key} />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api(`/api-keys/${apiKey!.id}`, {
                method: 'PATCH',
                body: {
                  name,
                  scopes,
                  ip_restrictions: split(ips),
                  allowed_endpoints: split(endpoints),
                  rate_limit: rateLimit ? Number(rateLimit) : null,
                  expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
                  notes: notes || null,
                },
              });
              toast.success('API key updated');
              void qc.invalidateQueries({ queryKey: ['api-keys'] });
              onClose();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody>
            {detail.isLoading ? (
              <Skeleton className="h-64" />
            ) : (
              <>
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Scopes">
                  <div className="grid grid-cols-2 gap-2 rounded-md border p-2">
                    {(Object.keys(API_SCOPES) as ApiScope[]).map((s) => (
                      <label key={s} className="flex items-center gap-2 font-mono text-xs">
                        <Checkbox checked={scopes.includes(s)} onCheckedChange={(c) => setScopes((p) => (c === true ? [...p, s] : p.filter((x) => x !== s)))} />
                        {s}
                      </label>
                    ))}
                  </div>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Allowed IPs / CIDRs">
                    <Textarea className="font-mono text-xs" value={ips} onChange={(e) => setIps(e.target.value)} />
                  </Field>
                  <Field label="Allowed endpoints">
                    <Textarea className="font-mono text-xs" value={endpoints} onChange={(e) => setEndpoints(e.target.value)} />
                  </Field>
                  <Field label="Rate limit (req/min)">
                    <Input type="number" min={1} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} placeholder="Default" />
                  </Field>
                  <Field label="Expires at">
                    <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                  </Field>
                </div>
                <Field label="Notes (encrypted at rest)">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!scopes.length}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({ apiKey, onClose, onRotated }: { apiKey: ApiKeyDTO | null; onClose: () => void; onRotated: (key: string) => void }) {
  const qc = useQueryClient();
  const [grace, setGrace] = React.useState('0');
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={`Rotate ${apiKey?.name ?? ''}`} description="A new key with the same settings will be issued." />
        <DialogBody>
          <Field label="Old key remains valid for">
            <NativeSelect className="w-full" value={grace} onChange={(e) => setGrace(e.target.value)}>
              <option value="0">Revoke immediately</option>
              <option value="3600">1 hour</option>
              <option value="86400">24 hours</option>
              <option value="604800">7 days</option>
            </NativeSelect>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await api<{ key: string }>(`/api-keys/${apiKey!.id}/rotate`, { body: { grace_period_seconds: Number(grace) } });
                void qc.invalidateQueries({ queryKey: ['api-keys'] });
                onClose();
                onRotated(res.key);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Rotate key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ApiKeysPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiKeyDTO | null>(null);
  const [rotating, setRotating] = React.useState<ApiKeyDTO | null>(null);
  const [viewing, setViewing] = React.useState<ApiKeyDTO | null>(null);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const q = useQuery({ queryKey: ['api-keys', status, page], queryFn: () => api<Paginated<ApiKeyDTO>>('/api-keys', { query: { status: status || undefined, page, limit: 50 } }) });

  const toggle = async (k: ApiKeyDTO) => {
    try {
      await api(`/api-keys/${k.id}`, { method: 'PATCH', body: { enabled: !k.enabled } });
      toast.success(k.enabled ? 'Key disabled' : 'Key enabled');
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="API Keys"
        description="Keys authenticate external applications with Authorization: Bearer. Secrets are shown once and stored only as a keyed hash."
        actions={
          <>
            {can('api_keys.revoke') && (
              <Button
                variant="secondary"
                onClick={() =>
                  confirm({
                    title: 'Revoke all API keys?',
                    description: 'Every active key stops working immediately. Use this if keys may have leaked.',
                    destructive: true,
                    confirmLabel: 'Revoke all',
                    typeToConfirm: 'REVOKE ALL',
                    requireReauth: true,
                    action: async () => {
                      const r = await api<{ revoked: number }>('/api-keys/revoke-all', { body: { confirm: 'REVOKE ALL' } });
                      toast.success(`${r.revoked} key(s) revoked`);
                      void qc.invalidateQueries({ queryKey: ['api-keys'] });
                    },
                  })
                }
              >
                <ShieldOff /> Revoke all
              </Button>
            )}
            {can('api_keys.create') && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> Create API key
              </Button>
            )}
          </>
        }
      />
      <div className="mb-3">
        <NativeSelect value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Status filter">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </NativeSelect>
      </div>
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Panel>
        {q.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !q.data?.data.length ? (
          <EmptyState icon={KeyRound} title="No API keys" description="Create a key to let applications upload and fetch files through the API." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Key</TH>
                <TH>Status</TH>
                <TH>Scopes</TH>
                <TH>Created</TH>
                <TH>Last used</TH>
                <TH>Last IP</TH>
                <TH className="text-right">Requests</TH>
                <TH>Expires</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {q.data.data.map((k) => (
                <TR key={k.id} className="cursor-pointer" onClick={() => setViewing(k)}>
                  <TD className="font-medium">{k.name}</TD>
                  <TD className="font-mono text-xs">{k.masked_key}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[k.status]}>{k.status}</Badge>
                  </TD>
                  <TD className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground" title={k.scopes.join(', ')}>
                    {k.scopes.join(', ')}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDate(k.created_at, false)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(k.last_used_at)}</TD>
                  <TD className="font-mono text-xs text-muted-foreground">{k.last_used_ip ?? '—'}</TD>
                  <TD className="text-right tabular">{formatNumber(k.request_count)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{k.expires_at ? formatDate(k.expires_at, false) : 'Never'}</TD>
                  <TD onClick={(e) => e.stopPropagation()}>
                    {k.status !== 'revoked' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Key actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {can('api_keys.create') && (
                            <DropdownMenuItem onSelect={() => setEditing(k)}>
                              <Pencil /> Edit
                            </DropdownMenuItem>
                          )}
                          {can('api_keys.rotate') && (
                            <DropdownMenuItem onSelect={() => setRotating(k)}>
                              <RotateCw /> Rotate
                            </DropdownMenuItem>
                          )}
                          {can('api_keys.revoke') && (
                            <DropdownMenuItem onSelect={() => void toggle(k)}>
                              <Power /> {k.enabled ? 'Disable' : 'Enable'}
                            </DropdownMenuItem>
                          )}
                          {can('api_keys.revoke') && k.status === 'suspended' && (
                            <DropdownMenuItem
                              onSelect={async () => {
                                await api(`/api-keys/${k.id}/unsuspend`, { method: 'POST' });
                                void qc.invalidateQueries({ queryKey: ['api-keys'] });
                              }}
                            >
                              <Power /> Lift suspension
                            </DropdownMenuItem>
                          )}
                          {can('api_keys.revoke') && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                destructive
                                onSelect={() =>
                                  confirm({
                                    title: `Revoke ${k.name}?`,
                                    description: `Requests using ${k.masked_key} will fail immediately. This cannot be undone.`,
                                    destructive: true,
                                    confirmLabel: 'Revoke key',
                                    successMessage: 'API key revoked',
                                    action: async () => {
                                      await api(`/api-keys/${k.id}`, { method: 'DELETE' });
                                      void qc.invalidateQueries({ queryKey: ['api-keys'] });
                                    },
                                  })
                                }
                              >
                                <Ban /> Revoke
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {q.data && <Pagination page={page} totalPages={q.data.pagination.total_pages} total={q.data.pagination.total} onPage={setPage} />}
      </Panel>

      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent>
          <DialogHeader title={viewing?.name ?? ''} description={viewing?.masked_key} />
          <DialogBody>
            {viewing && (
              <KeyValue
                items={[
                  ['Status', <Badge key="s" tone={STATUS_TONE[viewing.status]}>{viewing.status}</Badge>],
                  ['Environment', viewing.environment],
                  ['Prefix', <span key="p" className="font-mono text-xs">{viewing.prefix}</span>],
                  ['Scopes', <span key="sc" className="font-mono text-xs">{viewing.scopes.join(', ')}</span>],
                  ['Rate limit', viewing.rate_limit ? `${viewing.rate_limit}/min` : 'Default'],
                  ['IP restrictions', viewing.ip_restrictions.join(', ') || 'Any'],
                  ['Endpoints', viewing.allowed_endpoints.join(', ') || 'All (by scope)'],
                  ['Created', `${formatDate(viewing.created_at)}${viewing.created_by ? ` by ${viewing.created_by.name}` : ''}`],
                  ['Last used', viewing.last_used_at ? `${formatDate(viewing.last_used_at)} from ${viewing.last_used_ip}` : 'Never'],
                  ['Requests', formatNumber(viewing.request_count)],
                  ['Expires', viewing.expires_at ? formatDate(viewing.expires_at) : 'Never'],
                  ['Project scope', viewing.project_id ?? 'All files'],
                  ...(viewing.service_account_id ? [['Service account', viewing.service_account_id] as [string, string]] : []),
                  ...(viewing.suspended_at ? [['Suspended', `${formatDate(viewing.suspended_at)} — ${viewing.suspended_reason ?? ''}`] as [string, string]] : []),
                  ...(viewing.revoked_at ? [['Revoked', `${formatDate(viewing.revoked_at)}${viewing.revoked_reason ? ` (${viewing.revoked_reason})` : ''}`] as [string, string]] : []),
                ]}
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditKeyDialog apiKey={editing} onClose={() => setEditing(null)} />
      <RotateDialog apiKey={rotating} onClose={() => setRotating(null)} onRotated={setRevealed} />
      <RevealKeyDialog value={revealed} onClose={() => setRevealed(null)} />
    </>
  );
}
