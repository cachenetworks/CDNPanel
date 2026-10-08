'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FileDTO } from '@/lib/types';
import { formatBytes, formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { EmptyState, ErrorState, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { FileIcon } from '@/components/files/file-icon';
import { useConfirm } from '@/components/confirm';

export default function TrashPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: { files: { trashRetentionDays: number } } }>('/settings'), enabled: can('settings.view') });
  const list = useQuery({ queryKey: ['trash', q, page], queryFn: () => api<Paginated<FileDTO>>('/trash', { query: { q, page, limit: 50 } }) });
  const retention = settings.data?.settings.files.trashRetentionDays;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['trash'] });
    void qc.invalidateQueries({ queryKey: ['files'] });
  };
  return (
    <>
      <PageHeader
        title="Recycle Bin"
        description={`Deleted files stop being served immediately and can be restored${retention !== undefined ? ` for ${retention} days` : ''}, then they are deleted permanently.`}
        actions={
          can('files.delete') &&
          (list.data?.pagination.total ?? 0) > 0 && (
            <Button
              variant="destructive"
              onClick={() =>
                confirm({
                  title: 'Empty the recycle bin?',
                  description: 'Every file in the recycle bin is deleted permanently. This cannot be undone.',
                  destructive: true,
                  requireReauth: true,
                  confirmLabel: 'Empty recycle bin',
                  successMessage: 'Recycle bin emptied',
                  action: async () => {
                    await api('/trash/empty', { method: 'POST' });
                    refresh();
                  },
                })
              }
            >
              <Trash2 /> Empty
            </Button>
          )
        }
      />
      <div className="mb-3 max-w-sm">
        <Input placeholder="Search deleted files…" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
      </div>
      {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
      <Panel>
        {!list.data ? (
          <Skeleton className="m-3 h-40" />
        ) : list.data.data.length === 0 ? (
          <EmptyState icon={Trash2} title="The recycle bin is empty" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Folder</TH>
                <TH className="text-right">Size</TH>
                <TH>Deleted</TH>
                <TH>Purged</TH>
                <TH className="w-44" />
              </tr>
            </THead>
            <tbody>
              {list.data.data.map((f) => (
                <TR key={f.id}>
                  <TD>
                    <span className="flex items-center gap-2 font-medium">
                      <FileIcon mime={f.mime_type} /> {f.name}
                    </span>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{f.folder_path ?? '/'}</TD>
                  <TD className="text-right tabular">{formatBytes(f.size)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(f.deleted_at)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{retention !== undefined && f.deleted_at ? formatDate(new Date(new Date(f.deleted_at).getTime() + retention * 86_400_000).toISOString(), false) : '—'}</TD>
                  <TD>
                    {can('files.delete') && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={async () => {
                            try {
                              await api(`/files/${f.id}/restore`, { body: {} });
                              toast.success(`${f.name} restored`);
                              refresh();
                            } catch (err) {
                              toast.error(errorMessage(err));
                            }
                          }}
                        >
                          <RotateCcw /> Restore
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() =>
                            confirm({
                              title: `Delete ${f.name} permanently?`,
                              destructive: true,
                              confirmLabel: 'Delete forever',
                              successMessage: 'File deleted',
                              action: async () => {
                                await api(`/trash/${f.id}`, { method: 'DELETE' });
                                refresh();
                              },
                            })
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {list.data && <Pagination page={page} totalPages={list.data.pagination.total_pages} total={list.data.pagination.total} onPage={setPage} />}
      </Panel>
    </>
  );
}
