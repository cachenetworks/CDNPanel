'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Share2 } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import type { ShareDTO } from '@/lib/types';
import { formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, KeyValue, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm } from '@/components/confirm';

const STATE_TONE = { active: 'success', expired: 'warning', exhausted: 'neutral', revoked: 'danger' } as const;

interface ShareDetail extends ShareDTO {
  accesses: { timestamp: string; email: string | null; ip: string | null; country: string | null; user_agent: string | null; downloaded: boolean }[];
}

function shareLimits(s: ShareDTO): string {
  const parts = [];
  if (s.has_password) parts.push('password');
  if (s.require_email) parts.push('email');
  if (s.one_time) parts.push('one-time');
  else if (s.max_downloads) parts.push(`${s.download_count}/${s.max_downloads} downloads`);
  if (s.allowed_countries.length) parts.push(s.allowed_countries.join(' '));
  if (s.allowed_ips.length) parts.push(`${s.allowed_ips.length} IP rule(s)`);
  return parts.join(' · ') || 'none';
}

export default function SharesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [state, setState] = React.useState<'all' | 'active' | 'inactive'>('active');
  const [page, setPage] = React.useState(1);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const q = useQuery({ queryKey: ['shares', state, page], queryFn: () => api<Paginated<ShareDTO>>('/shares', { query: { state, page, limit: 50 } }) });
  const detail = useQuery({ queryKey: ['share', viewing], queryFn: () => api<ShareDetail>(`/shares/${viewing}`), enabled: Boolean(viewing) });

  const revoke = (s: ShareDTO) =>
    confirm({
      title: 'Revoke this share link?',
      description: 'Anyone holding the link loses access immediately.',
      destructive: true,
      confirmLabel: 'Revoke link',
      successMessage: 'Share link revoked',
      action: async () => {
        await api(`/shares/${s.id}/revoke`, { method: 'POST' });
        void qc.invalidateQueries({ queryKey: ['shares'] });
        void qc.invalidateQueries({ queryKey: ['share', s.id] });
      },
    });

  return (
    <>
      <PageHeader
        title="Share Links"
        description="Human-friendly links to private files with optional passwords, expiry, download limits, one-time use, IP / country restrictions and email capture. Create them from a file’s details panel."
        actions={
          <NativeSelect value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Filter">
            <option value="active">Active</option>
            <option value="inactive">Expired / revoked</option>
            <option value="all">All</option>
          </NativeSelect>
        }
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Panel>
        {!q.data ? (
          <Skeleton className="m-3 h-40" />
        ) : q.data.data.length === 0 ? (
          <EmptyState icon={Share2} title="No share links" description="Open a file and choose “Share” to create one." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>File</TH>
                <TH>Link</TH>
                <TH>State</TH>
                <TH>Protection</TH>
                <TH>Expires</TH>
                <TH>Last opened</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {q.data.data.map((s) => (
                <TR key={s.id} className="cursor-pointer" onClick={() => setViewing(s.id)}>
                  <TD>
                    <div className="font-medium">{s.title ?? s.file?.name}</div>
                    {s.title && <div className="text-xs text-muted-foreground">{s.file?.name}</div>}
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">/s/{s.token_prefix}…</TD>
                  <TD>
                    <Badge tone={STATE_TONE[s.state]}>{s.state}</Badge>
                  </TD>
                  <TD className="text-xs">{shareLimits(s)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{s.expires_at ? formatDate(s.expires_at) : 'Never'}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(s.last_accessed_at)}</TD>
                  <TD onClick={(e) => e.stopPropagation()}>
                    {s.state === 'active' && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Revoke" onClick={() => revoke(s)}>
                        <Ban />
                      </Button>
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
        <DialogContent size="lg">
          <DialogHeader title={detail.data?.title ?? detail.data?.file?.name ?? 'Share link'} description="The full link (with its secret token) is only shown when it is created." />
          <DialogBody>
            {!detail.data ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                <KeyValue
                  items={[
                    ['State', <Badge key="s" tone={STATE_TONE[detail.data.state]}>{detail.data.state}</Badge>],
                    ['File', detail.data.file?.name ?? detail.data.file_id],
                    ['Protection', shareLimits(detail.data)],
                    ['Downloads', String(detail.data.download_count)],
                    ['Expires', detail.data.expires_at ? formatDate(detail.data.expires_at) : 'Never'],
                    ['Created', formatDate(detail.data.created_at)],
                  ]}
                />
                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Access log</h3>
                {detail.data.accesses.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Not opened yet.</p>
                ) : (
                  <div className="max-h-72 overflow-y-auto rounded-md border">
                    <Table>
                      <THead>
                        <tr>
                          <TH>When</TH>
                          <TH>Event</TH>
                          <TH>Email</TH>
                          <TH>Country</TH>
                          <TH>IP</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {detail.data.accesses.map((a, i) => (
                          <TR key={i}>
                            <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(a.timestamp)}</TD>
                            <TD>{a.downloaded ? <Badge tone="success">Download</Badge> : <Badge>View</Badge>}</TD>
                            <TD className="text-xs">{a.email ?? '—'}</TD>
                            <TD className="text-xs">{a.country ?? '—'}</TD>
                            <TD className="font-mono text-xs text-muted-foreground">{a.ip ?? '—'}</TD>
                          </TR>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {detail.data?.state === 'active' && (
              <Button variant="destructive" onClick={() => revoke(detail.data!)}>
                <Ban /> Revoke
              </Button>
            )}
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
