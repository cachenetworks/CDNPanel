'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Field, Input, Switch } from '../ui/form';
import { Badge, CopyButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Panel } from '../ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { useConfirm } from '../confirm';

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}
interface Delivery {
  id: string;
  event: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  response_code: number | null;
  last_error: string | null;
  created_at: string;
}

export function WebhooksSettings({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ data: Hook[]; events: string[] }>('/webhooks') });
  const [editing, setEditing] = React.useState<Hook | 'new' | null>(null);
  const [viewing, setViewing] = React.useState<Hook | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState<string[]>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const deliveries = useQuery({ queryKey: ['webhook-deliveries', viewing?.id], queryFn: () => api<Paginated<Delivery>>(`/webhooks/${viewing!.id}/deliveries`, { query: { limit: 25 } }), enabled: Boolean(viewing), refetchInterval: 5000 });

  React.useEffect(() => {
    if (editing === 'new') {
      setName('');
      setUrl('');
      setEvents(['file.uploaded']);
      setEnabled(true);
    } else if (editing) {
      setName(editing.name);
      setUrl(editing.url);
      setEvents(editing.events);
      setEnabled(editing.enabled);
    }
    setError(null);
  }, [editing]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="max-w-xl text-sm text-muted-foreground">Signed (HMAC-SHA256) HTTP callbacks for file and API key events, retried with exponential backoff.</p>
        {editable && (
          <Button onClick={() => setEditing('new')}>
            <Plus /> Add webhook
          </Button>
        )}
      </div>
      <Panel>
        {!q.data?.data.length ? (
          <EmptyState icon={Webhook} title="No webhooks" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>URL</TH>
                <TH>Events</TH>
                <TH>Status</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {q.data.data.map((h) => (
                <TR key={h.id} className="cursor-pointer" onClick={() => setViewing(h)}>
                  <TD className="font-medium">{h.name}</TD>
                  <TD className="max-w-[260px] truncate font-mono text-xs">{h.url}</TD>
                  <TD className="text-xs text-muted-foreground">{h.events.join(', ')}</TD>
                  <TD>{h.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</TD>
                  <TD onClick={(e) => e.stopPropagation()}>
                    {editable && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="xs" variant="ghost">
                            Manage
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setEditing(h)}>Edit</DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={async () => {
                              try {
                                await api(`/webhooks/${h.id}/test`, { method: 'POST' });
                                toast.success('Test event queued');
                              } catch (err) {
                                toast.error(errorMessage(err));
                              }
                            }}
                          >
                            Send test event
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              confirm({
                                title: 'Rotate signing secret?',
                                description: 'The current secret stops working immediately.',
                                confirmLabel: 'Rotate',
                                action: async () => setSecret((await api<{ secret: string }>(`/webhooks/${h.id}/rotate-secret`, { method: 'POST' })).secret),
                              })
                            }
                          >
                            Rotate secret
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            destructive
                            onSelect={() =>
                              confirm({
                                title: `Delete webhook ${h.name}?`,
                                destructive: true,
                                confirmLabel: 'Delete',
                                successMessage: 'Webhook deleted',
                                action: async () => {
                                  await api(`/webhooks/${h.id}`, { method: 'DELETE' });
                                  refresh();
                                },
                              })
                            }
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader title={editing === 'new' ? 'Add webhook' : 'Edit webhook'} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                if (editing === 'new') {
                  const res = await api<{ secret: string }>('/webhooks', { body: { name, url, events, enabled } });
                  setSecret(res.secret);
                } else {
                  await api(`/webhooks/${editing!.id}`, { method: 'PATCH', body: { name, url, events, enabled } });
                  toast.success('Webhook updated');
                }
                refresh();
                setEditing(null);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogBody>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Endpoint URL" hint="Must use HTTPS. Private network addresses are blocked.">
                <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://hooks.example.com/cdn" />
              </Field>
              <Field label="Events">
                <div className="grid grid-cols-2 gap-2 rounded-md border p-2">
                  {(q.data?.events ?? []).map((ev) => (
                    <label key={ev} className="flex items-center gap-2 font-mono text-xs">
                      <Checkbox checked={events.includes(ev)} onCheckedChange={(c) => setEvents((p) => (c === true ? [...p, ev] : p.filter((x) => x !== ev)))} />
                      {ev}
                    </label>
                  ))}
                </div>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={enabled} onCheckedChange={setEnabled} /> Enabled
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!events.length}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(secret)} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader title="Webhook signing secret" description="Copy it now — it will not be shown again. Use it to verify the X-CDN-Signature header." />
          <DialogBody>
            <code className="block break-all rounded-md border bg-subtle p-2 text-xs">{secret}</code>
            {secret && (
              <CopyButton value={secret} label="Secret copied">
                Copy secret
              </CopyButton>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent size="lg">
          <DialogHeader title={`Deliveries · ${viewing?.name ?? ''}`} description={viewing?.url} />
          <DialogBody>
            {!deliveries.data?.data.length ? (
              <EmptyState title="No deliveries yet" />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Event</TH>
                    <TH>Status</TH>
                    <TH>Attempts</TH>
                    <TH>Response</TH>
                    <TH>Time</TH>
                    <TH />
                  </tr>
                </THead>
                <tbody>
                  {deliveries.data.data.map((d) => (
                    <TR key={d.id}>
                      <TD className="font-mono text-xs">{d.event}</TD>
                      <TD>
                        <Badge tone={d.status === 'SUCCEEDED' ? 'success' : d.status === 'FAILED' ? 'danger' : 'warning'}>{d.status.toLowerCase()}</Badge>
                      </TD>
                      <TD className="tabular">{d.attempts}</TD>
                      <TD className="max-w-[180px] truncate text-xs text-muted-foreground" title={d.last_error ?? ''}>
                        {d.response_code ?? d.last_error ?? '—'}
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(d.created_at)}</TD>
                      <TD>
                        {editable && d.status === 'FAILED' && (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={async () => {
                              await api(`/webhooks/deliveries/${d.id}/retry`, { method: 'POST' });
                              toast.success('Retry queued');
                              void deliveries.refetch();
                            }}
                          >
                            Retry
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
