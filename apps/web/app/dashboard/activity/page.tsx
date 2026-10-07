'use client';
import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Input, NativeSelect } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { CodeBlock } from '@/components/docs/code';

interface AuditEntry {
  id: string;
  timestamp: string;
  actor_id: string | null;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

function tone(action: string) {
  if (/FAILED|DELETE|REVOKE|DISABLE|QUARANTINE/.test(action)) return 'danger' as const;
  if (/CREATE|UPLOAD|ENABLE|SUCCESS/.test(action)) return 'success' as const;
  return 'neutral' as const;
}

export default function ActivityPage() {
  const [action, setAction] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<AuditEntry | null>(null);
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: () => api<{ data: string[] }>('/audit-logs/actions') });
  const q = useQuery({
    queryKey: ['audit', action, search, from, page],
    queryFn: () => api<Paginated<AuditEntry>>('/audit-logs', { query: { action: action || undefined, q: search || undefined, from: from ? new Date(from).toISOString() : undefined, page, limit: 50 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Activity Logs" description="Append-only audit trail of sensitive staff and API actions. Credentials are never recorded." />
      <div className="mb-3 flex flex-wrap gap-2">
        <NativeSelect value={action} onChange={(e) => (setAction(e.target.value), setPage(1))} aria-label="Action">
          <option value="">All actions</option>
          {(actions.data?.data ?? []).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </NativeSelect>
        <Input className="max-w-xs" placeholder="Actor, target id or IP…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        <Input type="date" className="w-auto" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} aria-label="From date" />
      </div>
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Panel>
        {q.isLoading ? (
          <Skeleton className="m-3 h-64" />
        ) : !q.data?.data.length ? (
          <EmptyState icon={Activity} title="No matching activity" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Time</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Target</TH>
                <TH>IP</TH>
              </tr>
            </THead>
            <tbody>
              {q.data.data.map((e) => (
                <TR key={e.id} className="cursor-pointer" onClick={() => setOpen(e)}>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDate(e.timestamp)}</TD>
                  <TD className="max-w-[220px] truncate">
                    {e.actor_label ?? e.actor_type}
                    {e.actor_type !== 'user' && <span className="ml-1 text-[11px] text-muted-foreground">({e.actor_type})</span>}
                  </TD>
                  <TD>
                    <Badge tone={tone(e.action)} className="font-mono">
                      {e.action}
                    </Badge>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{e.target_type ? `${e.target_type}${e.target_id ? `:${e.target_id}` : ''}` : '—'}</TD>
                  <TD className="font-mono text-xs text-muted-foreground">{e.ip ?? '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {q.data && <Pagination page={page} totalPages={q.data.pagination.total_pages} total={q.data.pagination.total} onPage={setPage} />}
      </Panel>
      <Dialog open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent size="lg">
          <DialogHeader title={open?.action ?? ''} description={open ? formatDate(open.timestamp) : ''} />
          <DialogBody>{open && <CodeBlock language="json" code={JSON.stringify(open, null, 2)} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
