'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Files as FilesIcon, FolderPlus, Grid2x2, List, MoreHorizontal, Pencil, Search, Trash2, Upload, FolderInput, Link2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FileDTO, FolderDTO } from '@/lib/types';
import { cn, copyToClipboard, fileKind, formatBytes, formatDate, timeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, NativeSelect } from '@/components/ui/form';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, PageHeader, Pagination, Panel, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { FileIcon, FolderIcon } from '@/components/files/file-icon';
import { FileDetails, VisibilityBadge, statusTone } from '@/components/files/file-details';
import { FolderDialog } from '@/components/files/folder-dialog';
import { FolderPickerDialog } from '@/components/files/folder-picker';
import { useConfirm } from '@/components/confirm';
import { useUploads } from '@/components/uploads/upload-manager';
import { Dropzone } from '@/components/uploads/dropzone';
import { UploadList } from '@/components/uploads/upload-list';

type View = 'list' | 'grid';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Thumb({ file }: { file: FileDTO }) {
  if (fileKind(file.mime_type) === 'image' && file.mime_type !== 'image/svg+xml' && file.status === 'READY' && file.size < 15 * 1024 * 1024) {
    return <img src={`/api/v1/files/${file.id}/download?disposition=inline`} alt="" loading="lazy" className="h-full w-full object-cover" />;
  }
  return <FileIcon mime={file.mime_type} className="h-8 w-8" />;
}

function FilesBrowser() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const confirm = useConfirm();
  const { enqueue } = useUploads();

  const folderId = params.get('folder');
  const openFile = params.get('file');
  const [view, setView] = React.useState<View>('list');
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('');
  const [visibility, setVisibility] = React.useState('');
  const [sort, setSort] = React.useState('created_at:desc');
  const [createdAfter, setCreatedAfter] = React.useState('');
  const [minSize, setMinSize] = React.useState('');
  const [uploadedBy, setUploadedBy] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [folderDialog, setFolderDialog] = React.useState<{ open: boolean; folder?: FolderDTO | null }>({ open: false });
  const [moveFolder, setMoveFolder] = React.useState<FolderDTO | null>(null);
  const [bulkMove, setBulkMove] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const q = useDebounced(search);

  React.useEffect(() => {
    try {
      const v = localStorage.getItem('files.view');
      if (v === 'grid' || v === 'list') setView(v);
    } catch {
      /* ignore */
    }
  }, []);
  React.useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [folderId, q, type, visibility, sort, createdAfter, minSize, uploadedBy]);

  const searching = Boolean(q || type || visibility || createdAfter || minSize || uploadedBy);
  const [sortField, order] = sort.split(':') as [string, string];

  const folderQ = useQuery({ queryKey: ['folder', folderId], queryFn: () => api<FolderDTO>(`/folders/${folderId}`), enabled: Boolean(folderId) });
  const foldersQ = useQuery({
    queryKey: ['folders', folderId ?? 'root'],
    queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { parent_id: folderId ?? 'root', limit: 200 } }),
    enabled: !searching,
  });
  const usersQ = useQuery({ queryKey: ['users', 'picker'], queryFn: () => api<Paginated<{ id: string; name: string }>>('/users', { query: { limit: 200 } }), enabled: can('users.view') });
  const filesQ = useQuery({
    queryKey: ['files', { folderId, q, type, visibility, sort, page, createdAfter, minSize, uploadedBy }],
    queryFn: () =>
      api<Paginated<FileDTO>>('/files', {
        query: {
          folder_id: searching ? (folderId ?? undefined) : (folderId ?? 'root'),
          recursive: searching && folderId ? 'true' : undefined,
          q: q || undefined,
          type: type || undefined,
          visibility: visibility || undefined,
          created_after: createdAfter ? new Date(createdAfter).toISOString() : undefined,
          min_size: minSize ? Number(minSize) * 1024 * 1024 : undefined,
          uploaded_by: uploadedBy || undefined,
          sort: sortField,
          order,
          page,
          limit: 60,
        },
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.data.some((f) => f.status !== 'READY' && f.status !== 'FAILED' && f.status !== 'QUARANTINED') ? 4000 : false),
  });

  const files = filesQ.data?.data ?? [];
  const folders = searching ? [] : (foldersQ.data?.data ?? []);
  const crumbs = folderQ.data?.breadcrumbs ?? [];
  const folderLabel = folderQ.data?.path ?? '/';

  const goFolder = (id: string | null) => router.push(id ? `/dashboard/files?folder=${id}` : '/dashboard/files');
  const setFileParam = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set('file', id);
    else sp.delete('file');
    router.replace(`/dashboard/files?${sp.toString()}`);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.id));

  const onDropFiles = (list: File[]) => {
    if (!can('files.upload')) return toast.error('You do not have permission to upload files.');
    enqueue(list, { folderId, folderLabel });
    toast.message(`${list.length} file(s) queued for upload`, { action: { label: 'View', onClick: () => router.push('/dashboard/uploads') } });
  };

  const bulkDelete = () =>
    confirm({
      title: `Delete ${selected.size} file(s)?`,
      description: 'These files will be removed permanently.',
      confirmLabel: 'Delete files',
      destructive: true,
      typeToConfirm: selected.size > 20 ? 'DELETE' : undefined,
      requireReauth: selected.size > 20,
      action: async () => {
        const res = await api<{ deleted: number }>('/files/bulk-delete', { body: { ids: [...selected] } });
        toast.success(`${res.deleted} file(s) deleted`);
        setSelected(new Set());
        void qc.invalidateQueries({ queryKey: ['files'] });
      },
    });

  const deleteFolder = (folder: FolderDTO) => {
    const nonEmpty = (folder.file_count ?? 0) > 0 || (folder.folder_count ?? 0) > 0;
    confirm({
      title: `Delete folder ${folder.name}?`,
      description: nonEmpty ? 'This folder is not empty. All sub-folders and files inside will be permanently deleted.' : 'The empty folder will be deleted.',
      destructive: true,
      confirmLabel: 'Delete folder',
      typeToConfirm: nonEmpty ? folder.name : undefined,
      requireReauth: nonEmpty,
      successMessage: 'Folder deleted',
      action: async () => {
        await api(`/folders/${folder.id}`, { method: 'DELETE', query: { recursive: nonEmpty ? 'true' : 'false' } });
        void qc.invalidateQueries({ queryKey: ['folders'] });
        void qc.invalidateQueries({ queryKey: ['files'] });
      },
    });
  };

  const loading = filesQ.isLoading || (!searching && foldersQ.isLoading);
  const empty = !loading && files.length === 0 && folders.length === 0;

  const folderMenu = (folder: FolderDTO) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Folder actions" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => goFolder(folder.id)}>Open</DropdownMenuItem>
        {can('folders.edit') && (
          <DropdownMenuItem onSelect={() => setFolderDialog({ open: true, folder })}>
            <Pencil /> Rename & settings
          </DropdownMenuItem>
        )}
        {can('folders.edit') && (
          <DropdownMenuItem onSelect={() => setMoveFolder(folder)}>
            <FolderInput /> Move
          </DropdownMenuItem>
        )}
        {can('folders.delete') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => deleteFolder(folder)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const fileMenu = (f: FileDTO) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="File actions" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => setFileParam(f.id)}>Details</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyToClipboard(f.url).then(() => toast.success('CDN URL copied'))}>
          <Link2 /> Copy CDN URL
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyToClipboard(f.api_url).then(() => toast.success('API URL copied'))}>
          <Copy /> Copy API URL
        </DropdownMenuItem>
        {can('files.download') && (
          <DropdownMenuItem asChild>
            <a href={`/api/v1/files/${f.id}/download`}>Download</a>
          </DropdownMenuItem>
        )}
        {can('files.delete') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onSelect={() =>
                confirm({
                  title: `Delete ${f.name}?`,
                  destructive: true,
                  confirmLabel: 'Delete',
                  successMessage: 'File deleted',
                  action: async () => {
                    await api(`/files/${f.id}`, { method: 'DELETE' });
                    void qc.invalidateQueries({ queryKey: ['files'] });
                  },
                })
              }
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        onDropFiles(Array.from(e.dataTransfer.files));
      }}
      className="relative"
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-[hsl(var(--primary)/0.06)]">
          <p className="rounded-md bg-background px-3 py-2 text-sm font-medium shadow">Drop to upload to {folderLabel}</p>
        </div>
      )}
      <PageHeader
        title="Files"
        actions={
          <>
            {can('folders.create') && (
              <Button variant="secondary" onClick={() => setFolderDialog({ open: true, folder: null })}>
                <FolderPlus /> New folder
              </Button>
            )}
            {can('files.upload') && (
              <Button onClick={() => setUploadOpen(true)}>
                <Upload /> Upload
              </Button>
            )}
          </>
        }
      />

      <nav className="mb-3 flex flex-wrap items-center gap-1 text-[13px]" aria-label="Breadcrumb">
        <button type="button" onClick={() => goFolder(null)} className={cn('rounded px-1.5 py-0.5 hover:bg-accent', !folderId && 'font-medium')}>
          All files
        </button>
        {crumbs.map((c, i) => (
          <React.Fragment key={c.id}>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button type="button" onClick={() => goFolder(c.id)} className={cn('rounded px-1.5 py-0.5 hover:bg-accent', i === crumbs.length - 1 && 'font-medium')}>
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </nav>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder={folderId ? 'Search in this folder (name, ID, SHA-256)…' : 'Search files by name, ID or SHA-256…'} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <NativeSelect value={type} onChange={(e) => setType(e.target.value)} aria-label="File type">
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="document">Documents</option>
          <option value="archive">Archives</option>
          <option value="other">Other</option>
        </NativeSelect>
        <NativeSelect value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Visibility">
          <option value="">Any visibility</option>
          <option value="PUBLIC">Public</option>
          <option value="AUTHENTICATED">Authenticated</option>
          <option value="PRIVATE">Private</option>
          <option value="SIGNED_URL_ONLY">Signed URL only</option>
        </NativeSelect>
        {can('users.view') && (
          <NativeSelect value={uploadedBy} onChange={(e) => setUploadedBy(e.target.value)} aria-label="Uploader">
            <option value="">Any uploader</option>
            {(usersQ.data?.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <Input type="date" className="w-auto" value={createdAfter} onChange={(e) => setCreatedAfter(e.target.value)} aria-label="Uploaded after" title="Uploaded after" />
        <Input type="number" min={0} className="w-28" placeholder="Min MB" value={minSize} onChange={(e) => setMinSize(e.target.value)} aria-label="Minimum size in MB" />
        <NativeSelect value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="created_at:desc">Newest</option>
          <option value="created_at:asc">Oldest</option>
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="size:desc">Largest</option>
          <option value="size:asc">Smallest</option>
          <option value="downloads:desc">Most downloaded</option>
          <option value="bandwidth:desc">Most bandwidth</option>
        </NativeSelect>
        <div className="inline-flex rounded-md border p-0.5">
          {(['list', 'grid'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={`${v} view`}
              className={cn('rounded p-1.5 text-muted-foreground', view === v && 'bg-accent text-foreground')}
              onClick={() => {
                setView(v);
                try {
                  localStorage.setItem('files.view', v);
                } catch {
                  /* ignore */
                }
              }}
            >
              {v === 'list' ? <List className="h-4 w-4" /> : <Grid2x2 className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border bg-subtle px-3 py-2 text-[13px]">
          <span className="font-medium">{selected.size} selected</span>
          <div className="flex-1" />
          {can('files.edit') && (
            <Button size="sm" variant="secondary" onClick={() => setBulkMove(true)}>
              <FolderInput /> Move
            </Button>
          )}
          {can('files.delete') && (
            <Button size="sm" variant="destructive" onClick={bulkDelete}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {filesQ.isError && <ErrorState error={filesQ.error} onRetry={() => filesQ.refetch()} />}

      <Panel>
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : empty ? (
          <EmptyState
            icon={FilesIcon}
            title={searching ? 'No files match your filters' : 'This folder is empty'}
            description={searching ? 'Try a different search or clear the filters.' : can('files.upload') ? 'Drag files anywhere on this page, or use the Upload button.' : undefined}
            action={
              !searching && can('files.upload') ? (
                <Button onClick={() => setUploadOpen(true)}>
                  <Upload /> Upload files
                </Button>
              ) : undefined
            }
          />
        ) : view === 'list' ? (
          <Table>
            <THead>
              <tr>
                <TH className="w-10">
                  <Checkbox aria-label="Select all" checked={allSelected ? true : selected.size ? 'indeterminate' : false} onCheckedChange={(c) => setSelected(c === true ? new Set(files.map((f) => f.id)) : new Set())} />
                </TH>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH className="text-right">Size</TH>
                <TH>Visibility</TH>
                <TH className="text-right">Downloads</TH>
                <TH>Uploaded</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <tbody>
              {folders.map((fo) => (
                <TR key={fo.id} className="cursor-pointer" onClick={() => goFolder(fo.id)}>
                  <TD />
                  <TD>
                    <span className="flex items-center gap-2 font-medium">
                      <FolderIcon /> {fo.name}
                      {fo.restricted_to_role_ids.length > 0 && <Badge tone="outline">Restricted</Badge>}
                    </span>
                  </TD>
                  <TD className="text-muted-foreground">Folder</TD>
                  <TD className="text-right text-muted-foreground tabular">{fo.file_count ?? 0} files</TD>
                  <TD>{fo.visibility ? <VisibilityBadge v={fo.visibility} /> : <span className="text-xs text-muted-foreground">Inherit</span>}</TD>
                  <TD />
                  <TD className="text-muted-foreground">{formatDate(fo.created_at, false)}</TD>
                  <TD>{folderMenu(fo)}</TD>
                </TR>
              ))}
              {files.map((f) => (
                <TR key={f.id} className={cn('cursor-pointer', selected.has(f.id) && 'bg-[hsl(var(--primary)/0.05)]')} onClick={() => setFileParam(f.id)}>
                  <TD onClick={(e) => e.stopPropagation()}>
                    <Checkbox aria-label={`Select ${f.name}`} checked={selected.has(f.id)} onCheckedChange={() => toggle(f.id)} />
                  </TD>
                  <TD className="max-w-[360px]">
                    <span className="flex items-center gap-2">
                      <FileIcon mime={f.mime_type} />
                      <span className="truncate" title={f.name}>
                        {f.name}
                      </span>
                      {f.status !== 'READY' && <Badge tone={statusTone(f.status)}>{f.status}</Badge>}
                    </span>
                    {searching && f.folder_path && <span className="ml-6 block truncate text-[11px] text-muted-foreground">{f.folder_path}</span>}
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{f.mime_type}</TD>
                  <TD className="text-right tabular">{formatBytes(f.size)}</TD>
                  <TD>
                    <VisibilityBadge v={f.visibility} />
                  </TD>
                  <TD className="text-right tabular">{f.download_count.toLocaleString()}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground" title={formatDate(f.created_at)}>
                    {timeAgo(f.created_at)}
                  </TD>
                  <TD>{fileMenu(f)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {folders.map((fo) => (
              <div key={fo.id} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && goFolder(fo.id)} onClick={() => goFolder(fo.id)} className="group rounded-md border p-3 hover:bg-subtle">
                <div className="flex items-start justify-between">
                  <FolderIcon className="h-8 w-8" />
                  <div className="opacity-0 group-hover:opacity-100">{folderMenu(fo)}</div>
                </div>
                <p className="mt-2 truncate text-[13px] font-medium">{fo.name}</p>
                <p className="text-[11px] text-muted-foreground">{fo.file_count ?? 0} files</p>
              </div>
            ))}
            {files.map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setFileParam(f.id)}
                onClick={() => setFileParam(f.id)}
                className={cn('group relative overflow-hidden rounded-md border hover:bg-subtle', selected.has(f.id) && 'ring-2 ring-primary')}
              >
                <div className="absolute left-2 top-2 z-10" onClick={(e) => e.stopPropagation()}>
                  <Checkbox aria-label={`Select ${f.name}`} checked={selected.has(f.id)} onCheckedChange={() => toggle(f.id)} className={cn(!selected.has(f.id) && 'opacity-0 group-hover:opacity-100')} />
                </div>
                <div className="flex aspect-[4/3] items-center justify-center bg-subtle">
                  <Thumb file={f} />
                </div>
                <div className="p-2">
                  <p className="truncate text-[13px]" title={f.name}>
                    {f.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground tabular">{formatBytes(f.size)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {filesQ.data && filesQ.data.pagination.total_pages > 1 && <Pagination page={page} totalPages={filesQ.data.pagination.total_pages} total={filesQ.data.pagination.total} onPage={setPage} />}
      </Panel>

      <FileDetails fileId={openFile} onClose={() => setFileParam(null)} />
      <FolderDialog open={folderDialog.open} onOpenChange={(o) => setFolderDialog((s) => ({ ...s, open: o }))} folder={folderDialog.folder} parentId={folderId} />
      <FolderPickerDialog
        open={Boolean(moveFolder)}
        onOpenChange={(o) => !o && setMoveFolder(null)}
        title={`Move ${moveFolder?.name ?? 'folder'}`}
        confirmLabel="Move here"
        excludeSubtreeOf={moveFolder?.path}
        onPick={async (target) => {
          try {
            await api(`/folders/${moveFolder!.id}`, { method: 'PATCH', body: { parent_id: target } });
            toast.success('Folder moved');
            void qc.invalidateQueries({ queryKey: ['folders'] });
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
      <FolderPickerDialog
        open={bulkMove}
        onOpenChange={setBulkMove}
        title={`Move ${selected.size} file(s)`}
        confirmLabel="Move here"
        onPick={async (target) => {
          let ok = 0;
          for (const id of selected) {
            try {
              await api(`/files/${id}/move`, { body: { folder_id: target ?? 'root' } });
              ok++;
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }
          toast.success(`${ok} file(s) moved`);
          setSelected(new Set());
          void qc.invalidateQueries({ queryKey: ['files'] });
        }}
      />
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent size="lg">
          <DialogHeader title="Upload files" description={`Destination: ${folderLabel}`} />
          <DialogBody>
            <Dropzone compact onFiles={onDropFiles} />
            <div className="max-h-72 overflow-y-auto rounded-md border empty:hidden">
              <UploadList compact />
            </div>
            <p className="text-xs text-muted-foreground">
              Uploads continue in the background. Track them on the <Link className="text-primary hover:underline" href="/dashboard/uploads">Uploads</Link> page.
            </p>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function FilesPage() {
  return (
    <React.Suspense fallback={<Skeleton className="h-96" />}>
      <FilesBrowser />
    </React.Suspense>
  );
}
