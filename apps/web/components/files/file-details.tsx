'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Download, Link2, Trash2, X, FolderInput, CopyPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { VISIBILITIES, type FileDTO, type Visibility } from '@/lib/types';
import { cn, fileKind, formatBytes, formatDate, formatNumber } from '@/lib/utils';
import { Button } from '../ui/button';
import { Field, Input, NativeSelect, Switch, Label } from '../ui/form';
import { Badge, CopyButton, KeyValue, Skeleton } from '../ui/misc';
import { useConfirm } from '../confirm';
import { FolderPickerDialog } from './folder-picker';
import { CacheSection, ImageSection, MediaSection, SharesSection, VersionsSection } from './file-extras';

export function statusTone(s: FileDTO['status']) {
  return s === 'READY' ? 'success' : s === 'QUARANTINED' || s === 'FAILED' ? 'danger' : 'warning';
}

export function VisibilityBadge({ v }: { v: Visibility }) {
  const tone = v === 'PUBLIC' ? 'info' : v === 'PRIVATE' ? 'neutral' : 'outline';
  return <Badge tone={tone}>{VISIBILITIES.find((x) => x.value === v)?.label ?? v}</Badge>;
}

function Preview({ file }: { file: FileDTO }) {
  const src = `/api/v1/files/${file.id}/download?disposition=inline`;
  const kind = fileKind(file.mime_type);
  if (file.status !== 'READY') return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Preview available once the file is ready.</div>;
  if (kind === 'image' && file.mime_type !== 'image/svg+xml')
    return <img src={src} alt={file.name} className="mx-auto max-h-72 max-w-full object-contain" />;
  if (kind === 'video') return <video src={src} controls preload="metadata" className="max-h-72 w-full bg-black" />;
  if (kind === 'audio') return <audio src={src} controls className="w-full" />;
  return <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">No inline preview for {file.mime_type}</div>;
}

export function FileDetails({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['file', fileId], queryFn: () => api<FileDTO>(`/files/${fileId}`), enabled: Boolean(fileId) });
  const f = q.data;
  const [name, setName] = React.useState('');
  const [cacheControl, setCacheControl] = React.useState('');
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [copyOpen, setCopyOpen] = React.useState(false);
  const [expiresIn, setExpiresIn] = React.useState('3600');
  const [signed, setSigned] = React.useState<{ url: string; expires_at: string } | null>(null);

  React.useEffect(() => {
    if (f) {
      setName(f.name);
      setCacheControl(f.cache_control ?? '');
      setSigned(null);
    }
  }, [f]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['file', fileId] });
    void qc.invalidateQueries({ queryKey: ['files'] });
  };

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/files/${fileId}`, { method: 'PATCH', body });
      toast.success(msg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const editable = can('files.edit');

  return (
    <DialogPrimitive.Root open={Boolean(fileId)} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-xl">
          <div className="flex items-center gap-2 border-b px-5 py-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold">{f?.name ?? 'File'}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">File details</DialogPrimitive.Description>
            <DialogPrimitive.Close className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
            {!f ? (
              <Skeleton className="h-64" />
            ) : (
              <>
                <div className="rounded-lg border bg-subtle p-2">
                  <Preview file={f} />
                </div>

                <div className="flex flex-wrap gap-2">
                  {can('files.download') && (
                    <Button size="sm" variant="secondary" asChild>
                      <a href={`/api/v1/files/${f.id}/download`}>
                        <Download /> Download
                      </a>
                    </Button>
                  )}
                  <CopyButton value={f.url} label="CDN URL copied">
                    CDN URL
                  </CopyButton>
                  <CopyButton value={f.api_url} label="API URL copied">
                    API URL
                  </CopyButton>
                  {f.path_url && f.visibility === 'PUBLIC' && (
                    <CopyButton value={f.path_url} label="Path URL copied">
                      Path URL
                    </CopyButton>
                  )}
                  {editable && (
                    <Button size="sm" variant="secondary" onClick={() => setMoveOpen(true)}>
                      <FolderInput /> Move
                    </Button>
                  )}
                  {editable && can('files.upload') && (
                    <Button size="sm" variant="secondary" onClick={() => setCopyOpen(true)}>
                      <CopyPlus /> Copy
                    </Button>
                  )}
                  {can('files.delete') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-destructive"
                      onClick={() =>
                        confirm({
                          title: `Delete ${f.name}?`,
                          description: 'The file moves to the recycle bin and its URLs stop working. It can be restored until the retention period ends.',
                          confirmLabel: 'Move to recycle bin',
                          destructive: true,
                          successMessage: 'File moved to the recycle bin',
                          action: async () => {
                            await api(`/files/${f.id}`, { method: 'DELETE' });
                            void qc.invalidateQueries({ queryKey: ['files'] });
                            onClose();
                          },
                        })
                      }
                    >
                      <Trash2 /> Delete
                    </Button>
                  )}
                </div>

                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metadata</h3>
                  <KeyValue
                    items={[
                      ['File ID', <span key="id" className="flex items-center gap-1 font-mono text-xs">{f.id}<CopyButton value={f.id} /></span>],
                      ['Status', <span key="s" className="flex items-center gap-2"><Badge tone={statusTone(f.status)}>{f.status}</Badge>{f.status_reason && <span className="text-xs text-muted-foreground">{f.status_reason}</span>}</span>],
                      ['Visibility', <VisibilityBadge key="v" v={f.visibility} />],
                      ['File type', f.extension ? `.${f.extension}` : '—'],
                      ['MIME type', <span key="m" className="font-mono text-xs">{f.mime_type}</span>],
                      ['Size', `${formatBytes(f.size)} (${f.size.toLocaleString()} bytes)`],
                      ...(f.width && f.height ? [['Dimensions', `${f.width} × ${f.height}`] as [string, string]] : []),
                      ...(f.duration_seconds ? [['Duration', `${f.duration_seconds.toFixed(1)} s`] as [string, string]] : []),
                      ['Folder', f.folder_path ?? '/'],
                      ['Uploaded', formatDate(f.created_at)],
                      ['Uploaded by', f.uploaded_by ? `${f.uploaded_by.name} (${f.uploaded_by.email})` : f.uploaded_by_api_key ? `API key ${f.uploaded_by_api_key.name} (${f.uploaded_by_api_key.prefix})` : '—'],
                      ['SHA-256', <span key="sha" className="break-all font-mono text-[11px]">{f.sha256 ?? '—'}</span>],
                      ['Storage', `${f.storage_provider.name ?? f.storage_provider.id}${f.storage_provider.kind ? ` · ${f.storage_provider.kind}` : ''}${f.storage_class === 'archive' ? ' · archived' : ''}`],
                      ['Revision', `v${f.version}`],
                      ['Downloads', formatNumber(f.download_count)],
                      ['Bandwidth', formatBytes(f.bandwidth_bytes)],
                      ['Last accessed', formatDate(f.last_accessed_at)],
                    ]}
                  />
                </section>

                {editable && (
                  <section className="space-y-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</h3>
                    <form
                      className="flex items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void patch({ name }, 'File renamed');
                      }}
                    >
                      <div className="flex-1">
                        <Field label="Name">
                          <Input value={name} onChange={(e) => setName(e.target.value)} />
                        </Field>
                      </div>
                      <Button type="submit" variant="secondary" disabled={name === f.name || !name.trim()}>
                        Rename
                      </Button>
                    </form>
                    <Field label="Visibility">
                      <NativeSelect className="w-full" value={f.visibility} onChange={(e) => void patch({ visibility: e.target.value }, 'Visibility updated')}>
                        {VISIBILITIES.map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.label} — {v.description}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <form
                      className="flex items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void patch({ cache_control: cacheControl.trim() || null }, 'Cache settings updated');
                      }}
                    >
                      <div className="flex-1">
                        <Field label="Cache-Control override" hint="Empty uses the default from settings. Only applies to public files.">
                          <Input value={cacheControl} onChange={(e) => setCacheControl(e.target.value)} placeholder="public, max-age=31536000, immutable" />
                        </Field>
                      </div>
                      <Button type="submit" variant="secondary">
                        Save
                      </Button>
                    </form>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <Label>Force download</Label>
                        <p className="text-xs text-muted-foreground">Always serve with Content-Disposition: attachment.</p>
                      </div>
                      <Switch checked={f.force_download} onCheckedChange={(v) => void patch({ force_download: v }, 'Download behaviour updated')} />
                    </div>
                  </section>
                )}

                {can('files.download') && f.status === 'READY' && (
                  <section className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signed URL</h3>
                    <div className="flex items-end gap-2">
                      <Field label="Expires in">
                        <NativeSelect value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
                          <option value="300">5 minutes</option>
                          <option value="3600">1 hour</option>
                          <option value="86400">1 day</option>
                          <option value="604800">7 days</option>
                        </NativeSelect>
                      </Field>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          try {
                            setSigned(await api(`/files/${f.id}/signed-url`, { body: { expires_in: Number(expiresIn) } }));
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <Link2 /> Generate
                      </Button>
                    </div>
                    {signed && (
                      <div className="rounded-md border bg-subtle p-2">
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate text-xs">{signed.url}</code>
                          <CopyButton value={signed.url} label="Signed URL copied" />
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">Expires {formatDate(signed.expires_at)}</p>
                      </div>
                    )}
                  </section>
                )}
                <MediaSection file={f} />
                <ImageSection file={f} />
                <VersionsSection file={f} onChanged={refresh} />
                {can('shares.manage') && <SharesSection file={f} />}
                <CacheSection file={f} onChanged={refresh} />
                {Object.keys(f.metadata ?? {}).length > 0 && (
                  <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Custom metadata</h3>
                    <pre className={cn('overflow-x-auto rounded-md bg-subtle p-3 text-xs')}>{JSON.stringify(f.metadata, null, 2)}</pre>
                  </section>
                )}
              </>
            )}
          </div>
          {f && (
            <>
              <FolderPickerDialog
                open={moveOpen}
                onOpenChange={setMoveOpen}
                title="Move file"
                confirmLabel="Move here"
                onPick={async (folderId) => {
                  try {
                    await api(`/files/${f.id}/move`, { body: { folder_id: folderId ?? 'root' } });
                    toast.success('File moved');
                    refresh();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              />
              <FolderPickerDialog
                open={copyOpen}
                onOpenChange={setCopyOpen}
                title="Copy file to…"
                confirmLabel="Copy here"
                onPick={async (folderId) => {
                  try {
                    await api(`/files/${f.id}/copy`, { body: { folder_id: folderId ?? 'root' } });
                    toast.success('File copied');
                    refresh();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              />
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
