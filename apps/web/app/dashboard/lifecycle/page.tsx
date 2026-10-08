'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Eye, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FolderDTO, StorageProviderDTO, ZoneDTO } from '@/lib/types';
import { formatBytes, formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Switch } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm, useStepUp } from '@/components/confirm';

interface Rule {
  id: string;
  name: string;
  zone_id: string | null;
  folder_id: string | null;
  basis: 'created' | 'last_accessed';
  after_days: number;
  action: 'TRASH' | 'DELETE' | 'ARCHIVE' | 'MOVE_STORAGE';
  target_storage_provider_id: string | null;
  mime_prefix: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_run_count: number;
}

const ACTIONS: { value: Rule['action']; label: string; hint: string }[] = [
  { value: 'TRASH', label: 'Move to recycle bin', hint: 'Restorable until the recycle bin retention passes.' },
  { value: 'DELETE', label: 'Delete permanently', hint: 'Irreversible.' },
  { value: 'ARCHIVE', label: 'Archive to cold storage', hint: 'Moves the object to a cheaper provider and marks it archived. URLs keep working.' },
  { value: 'MOVE_STORAGE', label: 'Move to another provider', hint: 'Storage tiering. URLs keep working.' },
];

function RuleDialog({ open, onOpenChange, zones, folders, providers }: { open: boolean; onOpenChange: (o: boolean) => void; zones: ZoneDTO[]; folders: FolderDTO[]; providers: StorageProviderDTO[] }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState('all');
  const [basis, setBasis] = React.useState<Rule['basis']>('created');
  const [days, setDays] = React.useState('90');
  const [action, setAction] = React.useState<Rule['action']>('TRASH');
  const [target, setTarget] = React.useState('');
  const [mime, setMime] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setName('');
      setScope('all');
      setBasis('created');
      setDays('90');
      setAction('TRASH');
      setTarget(providers[0]?.id ?? '');
      setMime('');
    }
  }, [open, providers]);
  const needsTarget = action === 'ARCHIVE' || action === 'MOVE_STORAGE';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="New lifecycle rule" description="Rules run daily at 02:45 UTC (or on demand). Preview a rule before enabling destructive actions." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/lifecycle-rules', {
                body: {
                  name,
                  zone_id: scope.startsWith('zon_') ? scope : null,
                  folder_id: scope.startsWith('fld_') ? scope : null,
                  basis,
                  after_days: Number(days),
                  action,
                  target_storage_provider_id: needsTarget ? target : null,
                  mime_prefix: mime.trim() || null,
                },
              });
              toast.success('Lifecycle rule created');
              void qc.invalidateQueries({ queryKey: ['lifecycle-rules'] });
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Archive old videos" />
              </Field>
              <Field label="Applies to">
                <NativeSelect className="w-full" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="all">Every file</option>
                  <optgroup label="Zones">
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Folders">
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.path}
                      </option>
                    ))}
                  </optgroup>
                </NativeSelect>
              </Field>
              <Field label="When files are older than">
                <div className="flex gap-2">
                  <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" required />
                  <NativeSelect className="flex-1" value={basis} onChange={(e) => setBasis(e.target.value as Rule['basis'])}>
                    <option value="created">days since upload</option>
                    <option value="last_accessed">days since last download</option>
                  </NativeSelect>
                </div>
              </Field>
              <Field label="Only MIME types starting with" hint="Optional, e.g. video/">
                <Input value={mime} onChange={(e) => setMime(e.target.value)} placeholder="video/" />
              </Field>
              <Field label="Action" hint={ACTIONS.find((a) => a.value === action)?.hint}>
                <NativeSelect className="w-full" value={action} onChange={(e) => setAction(e.target.value as Rule['action'])}>
                  {ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {needsTarget && (
                <Field label="Target provider">
                  <NativeSelect className="w-full" value={target} onChange={(e) => setTarget(e.target.value)} required>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.kind}{p.region ? ` · ${p.region}` : ''})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create rule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function LifecyclePage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [dialog, setDialog] = React.useState(false);
  const [preview, setPreview] = React.useState<{ rule: Rule; matches: number; capped: boolean; sample: { id: string; name: string; size: number; created_at: string }[] } | null>(null);
  const rules = useQuery({ queryKey: ['lifecycle-rules'], queryFn: () => api<{ data: Rule[] }>('/lifecycle-rules') });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ data: ZoneDTO[] }>('/zones') });
  const folders = useQuery({ queryKey: ['folders', 'all'], queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { all: 'true', limit: 500 } }) });
  const providers = useQuery({ queryKey: ['storage'], queryFn: () => api<{ providers: StorageProviderDTO[] }>('/storage') });
  const manage = can('zones.manage');
  const scopeLabel = (r: Rule) =>
    r.zone_id ? `Zone ${zones.data?.data.find((z) => z.id === r.zone_id)?.name ?? r.zone_id}` : r.folder_id ? (folders.data?.data.find((f) => f.id === r.folder_id)?.path ?? r.folder_id) : 'Every file';
  return (
    <>
      <PageHeader
        title="Lifecycle Rules"
        description="Expire, archive and tier files automatically. Files with an expiry date (set at upload) move to the recycle bin on their own."
        actions={
          manage && (
            <>
              <Button
                variant="secondary"
                onClick={() =>
                  stepUp(
                    async () => {
                      const r = await api<Record<string, number>>('/lifecycle/run', { method: 'POST' });
                      toast.success(`Lifecycle run complete: ${r.expired ?? 0} expired, ${r.trash_purged ?? 0} purged, ${r.versions_pruned ?? 0} revisions pruned`);
                      void qc.invalidateQueries({ queryKey: ['lifecycle-rules'] });
                    },
                    { title: 'Run lifecycle processing now' },
                  )
                }
              >
                <Play /> Run all now
              </Button>
              <Button onClick={() => setDialog(true)}>
                <Plus /> New rule
              </Button>
            </>
          )
        }
      />
      {rules.isError && <ErrorState error={rules.error} onRetry={() => rules.refetch()} />}
      <Panel>
        {!rules.data ? (
          <Skeleton className="m-3 h-32" />
        ) : rules.data.data.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No lifecycle rules" description="Example: move videos not downloaded for 180 days to cold storage." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Rule</TH>
                <TH>Scope</TH>
                <TH>Condition</TH>
                <TH>Action</TH>
                <TH>Last run</TH>
                <TH>Enabled</TH>
                <TH className="w-28" />
              </tr>
            </THead>
            <tbody>
              {rules.data.data.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.name}</TD>
                  <TD className="text-xs">{scopeLabel(r)}</TD>
                  <TD className="text-xs">
                    {r.after_days}d since {r.basis === 'created' ? 'upload' : 'last access'}
                    {r.mime_prefix && <span className="text-muted-foreground"> · {r.mime_prefix}*</span>}
                  </TD>
                  <TD>
                    <Badge tone={r.action === 'DELETE' ? 'danger' : r.action === 'TRASH' ? 'warning' : 'info'}>{ACTIONS.find((a) => a.value === r.action)?.label}</Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{r.last_run_at ? `${timeAgo(r.last_run_at)} · ${r.last_run_count} file(s)` : 'Never'}</TD>
                  <TD>
                    <Switch
                      disabled={!manage}
                      checked={r.enabled}
                      onCheckedChange={async (v) => {
                        await api(`/lifecycle-rules/${r.id}`, { method: 'PATCH', body: { enabled: v } }).catch((e) => toast.error(errorMessage(e)));
                        void qc.invalidateQueries({ queryKey: ['lifecycle-rules'] });
                      }}
                    />
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Preview" onClick={async () => setPreview({ rule: r, ...(await api<{ matches: number; capped: boolean; sample: { id: string; name: string; size: number; created_at: string }[] }>(`/lifecycle-rules/${r.id}/preview`)) })}>
                        <Eye />
                      </Button>
                      {manage && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive"
                          aria-label="Delete rule"
                          onClick={() =>
                            confirm({
                              title: `Delete rule ${r.name}?`,
                              destructive: true,
                              confirmLabel: 'Delete rule',
                              successMessage: 'Rule deleted',
                              action: async () => {
                                await api(`/lifecycle-rules/${r.id}`, { method: 'DELETE' });
                                void qc.invalidateQueries({ queryKey: ['lifecycle-rules'] });
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <RuleDialog open={dialog} onOpenChange={setDialog} zones={zones.data?.data ?? []} folders={folders.data?.data ?? []} providers={providers.data?.providers ?? []} />
      <Dialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent size="lg">
          <DialogHeader title={`Preview: ${preview?.rule.name ?? ''}`} description={preview ? `${preview.matches}${preview.capped ? '+' : ''} file(s) currently match — a run processes up to 500 per day.` : undefined} />
          <DialogBody>
            {preview && preview.sample.length > 0 ? (
              <Table>
                <THead>
                  <tr>
                    <TH>File</TH>
                    <TH className="text-right">Size</TH>
                    <TH>Uploaded</TH>
                  </tr>
                </THead>
                <tbody>
                  {preview.sample.map((f) => (
                    <TR key={f.id}>
                      <TD>{f.name}</TD>
                      <TD className="text-right tabular">{formatBytes(f.size)}</TD>
                      <TD className="text-muted-foreground">{formatDate(f.created_at, false)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[13px] text-muted-foreground">No files match right now.</p>
            )}
          </DialogBody>
          <DialogFooter>
            {preview && manage && preview.matches > 0 && (
              <Button
                variant={preview.rule.action === 'DELETE' ? 'destructive' : 'default'}
                onClick={() =>
                  stepUp(
                    async () => {
                      const r = await api<{ processed: number }>(`/lifecycle-rules/${preview.rule.id}/run`, { method: 'POST' });
                      toast.success(`${r.processed} file(s) processed`);
                      setPreview(null);
                      void qc.invalidateQueries({ queryKey: ['lifecycle-rules'] });
                    },
                    { title: `Run ${preview.rule.name} now` },
                  )
                }
              >
                <Play /> Run now
              </Button>
            )}
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
