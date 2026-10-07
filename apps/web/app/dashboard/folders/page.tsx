'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, FolderTree, MoreHorizontal, Pencil, Trash2, FolderInput, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FolderDTO } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from '@/components/ui/misc';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { FolderIcon } from '@/components/files/file-icon';
import { VisibilityBadge } from '@/components/files/file-details';
import { FolderDialog } from '@/components/files/folder-dialog';
import { FolderPickerDialog } from '@/components/files/folder-picker';
import { useConfirm } from '@/components/confirm';

export default function FoldersPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = React.useState('');
  const [dialog, setDialog] = React.useState<{ open: boolean; folder?: FolderDTO | null; parentId?: string | null }>({ open: false });
  const [moving, setMoving] = React.useState<FolderDTO | null>(null);
  const q = useQuery({ queryKey: ['folders', 'all'], queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { all: 'true', limit: 500 } }) });
  const rows = (q.data?.data ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()) || f.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <PageHeader
        title="Folders"
        description="Organise files into nested folders. Folders define friendly URLs (/p/folder/file), default visibility and optional role restrictions."
        actions={
          can('folders.create') && (
            <Button onClick={() => setDialog({ open: true, folder: null, parentId: null })}>
              <FolderPlus /> New folder
            </Button>
          )
        }
      />
      <div className="mb-3 max-w-sm">
        <Input placeholder="Filter by name or path…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Panel>
        {q.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={FolderTree} title={filter ? 'No folders match' : 'No folders yet'} description="Create folders such as /images, /videos, /releases or /backups." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Folder</TH>
                <TH>Path</TH>
                <TH className="text-right">Files</TH>
                <TH className="text-right">Sub-folders</TH>
                <TH>Default visibility</TH>
                <TH>Access</TH>
                <TH>Created</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {rows.map((f) => (
                <TR key={f.id}>
                  <TD>
                    <Link href={`/dashboard/files?folder=${f.id}`} className="flex items-center gap-2 font-medium hover:underline" style={{ paddingLeft: filter ? 0 : (f.path.split('/').length - 2) * 18 }}>
                      <FolderIcon /> {f.name}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{f.path}</TD>
                  <TD className="text-right tabular">{f.file_count ?? 0}</TD>
                  <TD className="text-right tabular">{f.folder_count ?? 0}</TD>
                  <TD>{f.visibility ? <VisibilityBadge v={f.visibility} /> : <span className="text-xs text-muted-foreground">Inherit</span>}</TD>
                  <TD>{f.restricted_to_role_ids.length ? <Badge tone="warning">{f.restricted_to_role_ids.length} role(s)</Badge> : <span className="text-xs text-muted-foreground">All staff</span>}</TD>
                  <TD className="text-muted-foreground">{formatDate(f.created_at, false)}</TD>
                  <TD>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Folder actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {can('folders.create') && (
                          <DropdownMenuItem onSelect={() => setDialog({ open: true, folder: null, parentId: f.id })}>
                            <Plus /> New sub-folder
                          </DropdownMenuItem>
                        )}
                        {can('folders.edit') && (
                          <DropdownMenuItem onSelect={() => setDialog({ open: true, folder: f })}>
                            <Pencil /> Rename & settings
                          </DropdownMenuItem>
                        )}
                        {can('folders.edit') && (
                          <DropdownMenuItem onSelect={() => setMoving(f)}>
                            <FolderInput /> Move
                          </DropdownMenuItem>
                        )}
                        {can('folders.delete') && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              onSelect={() => {
                                const nonEmpty = (f.file_count ?? 0) > 0 || (f.folder_count ?? 0) > 0;
                                confirm({
                                  title: `Delete ${f.path}?`,
                                  description: nonEmpty ? 'All sub-folders and files inside will be permanently deleted.' : 'The empty folder will be deleted.',
                                  destructive: true,
                                  confirmLabel: 'Delete folder',
                                  typeToConfirm: nonEmpty ? f.name : undefined,
                                  requireReauth: nonEmpty,
                                  successMessage: 'Folder deleted',
                                  action: async () => {
                                    await api(`/folders/${f.id}`, { method: 'DELETE', query: { recursive: nonEmpty ? 'true' : 'false' } });
                                    void qc.invalidateQueries({ queryKey: ['folders'] });
                                  },
                                });
                              }}
                            >
                              <Trash2 /> Delete
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
      </Panel>
      <FolderDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} folder={dialog.folder} parentId={dialog.parentId} />
      <FolderPickerDialog
        open={Boolean(moving)}
        onOpenChange={(o) => !o && setMoving(null)}
        title={`Move ${moving?.path ?? ''}`}
        confirmLabel="Move here"
        excludeSubtreeOf={moving?.path}
        onPick={async (target) => {
          try {
            await api(`/folders/${moving!.id}`, { method: 'PATCH', body: { parent_id: target } });
            toast.success('Folder moved');
            void qc.invalidateQueries({ queryKey: ['folders'] });
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </>
  );
}
