'use client';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ImageIcon, Play, RefreshCw, RotateCcw, Share2, Trash2, Upload, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, xhrUpload } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { FileDTO, ShareDTO } from '@/lib/types';
import { cn, formatBytes, formatDate, timeAgo } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '../ui/form';
import { Badge, CopyButton, KeyValue } from '../ui/misc';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog';
import { ListInput, StatusDot, formatTtl, healthTone } from '../ui/stat';
import { useConfirm } from '../confirm';

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

// ─── Revisions ───────────────────────────────────────────────────────────────

interface Version {
  version: number;
  name: string;
  size: number;
  sha256: string | null;
  mime_type: string;
  uploaded_at: string;
}

export function VersionsSection({ file, onChanged }: { file: FileDTO; onChanged: () => void }) {
  const { can } = useSession();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const q = useQuery({ queryKey: ['versions', file.id, file.version], queryFn: () => api<{ current_version: number; data: Version[] }>(`/files/${file.id}/versions`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['versions', file.id] });
    onChanged();
  };
  const upload = async (f: File) => {
    const form = new FormData();
    form.append('file', f);
    setProgress(0);
    try {
      await xhrUpload(`/api/v1/files/${file.id}/versions`, form, { onProgress: (l, t) => setProgress(t ? Math.round((l / t) * 100) : 0) });
      toast.success(`Revision ${file.version + 1} uploaded — edge caches are being purged`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };
  const editable = can('files.edit') && can('files.upload');
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <Heading>Revisions</Heading>
        {editable && (
          <>
            <input ref={inputRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button size="xs" variant="secondary" loading={progress !== null} onClick={() => inputRef.current?.click()}>
              <Upload /> {progress !== null ? `${progress}%` : 'Upload new revision'}
            </Button>
          </>
        )}
      </div>
      <div className="rounded-md border text-[13px]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Badge tone="success">v{file.version}</Badge>
          <span className="flex-1 truncate">{file.name}</span>
          <span className="tabular text-xs text-muted-foreground">{formatBytes(file.size)}</span>
          <span className="text-xs text-muted-foreground">current</span>
        </div>
        {q.data?.data.map((v) => (
          <div key={v.version} className="flex items-center gap-2 border-t px-3 py-2">
            <Badge>v{v.version}</Badge>
            <span className="flex-1 truncate">{v.name}</span>
            <span className="tabular text-xs text-muted-foreground">{formatBytes(v.size)}</span>
            <span className="text-xs text-muted-foreground">{timeAgo(v.uploaded_at)}</span>
            {can('files.edit') && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                aria-label={`Restore version ${v.version}`}
                onClick={() =>
                  confirm({
                    title: `Restore version ${v.version}?`,
                    description: 'Its content becomes current again (the current content is kept as a new revision). URLs stay the same and edge caches are purged.',
                    confirmLabel: 'Restore',
                    successMessage: 'Revision restored',
                    action: async () => {
                      await api(`/files/${file.id}/versions/${v.version}/restore`, { method: 'POST' });
                      refresh();
                    },
                  })
                }
              >
                <RotateCcw />
              </Button>
            )}
            {can('files.delete') && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                aria-label={`Delete version ${v.version}`}
                onClick={() =>
                  confirm({
                    title: `Delete version ${v.version}?`,
                    destructive: true,
                    confirmLabel: 'Delete revision',
                    successMessage: 'Revision deleted',
                    action: async () => {
                      await api(`/files/${file.id}/versions/${v.version}`, { method: 'DELETE' });
                      refresh();
                    },
                  })
                }
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
        {q.data && q.data.data.length === 0 && (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <History className="h-3.5 w-3.5" /> No previous revisions. Uploading a revision keeps the file id and URLs.
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Share links ─────────────────────────────────────────────────────────────

export function ShareDialog({ file, open, onOpenChange }: { file: FileDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [expires, setExpires] = React.useState('604800');
  const [maxDownloads, setMaxDownloads] = React.useState('');
  const [oneTime, setOneTime] = React.useState(false);
  const [requireEmail, setRequireEmail] = React.useState(false);
  const [countries, setCountries] = React.useState<string[]>([]);
  const [ips, setIps] = React.useState<string[]>([]);
  const [created, setCreated] = React.useState<ShareDTO | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setTitle('');
      setMessage('');
      setPassword('');
      setExpires('604800');
      setMaxDownloads('');
      setOneTime(false);
      setRequireEmail(false);
      setCountries([]);
      setIps([]);
      setCreated(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={`Share ${file.name}`} description="Anyone with the link can open a download page — no account or API key needed. Works for private files." />
        {created ? (
          <>
            <DialogBody>
              <p className="text-[13px] text-muted-foreground">Copy the link now — its secret token is not shown again.</p>
              <div className="flex items-center gap-2 rounded-md border bg-subtle p-2">
                <code className="min-w-0 flex-1 break-all text-xs">{created.url}</code>
                <CopyButton value={created.url!} label="Share link copied" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const s = await api<ShareDTO>(`/files/${file.id}/shares`, {
                  body: {
                    title: title || null,
                    message: message || null,
                    ...(password ? { password } : {}),
                    ...(expires ? { expires_in: Number(expires) } : {}),
                    max_downloads: maxDownloads ? Number(maxDownloads) : null,
                    one_time: oneTime,
                    require_email: requireEmail,
                    allowed_countries: countries,
                    allowed_ips: ips,
                  },
                });
                setCreated(s);
                void qc.invalidateQueries({ queryKey: ['shares'] });
                void qc.invalidateQueries({ queryKey: ['file-shares', file.id] });
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogBody>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Title (optional)">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={file.name} />
                </Field>
                <Field label="Password (optional)">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} autoComplete="new-password" />
                </Field>
                <Field label="Expires">
                  <NativeSelect className="w-full" value={expires} onChange={(e) => setExpires(e.target.value)}>
                    <option value="3600">In 1 hour</option>
                    <option value="86400">In 1 day</option>
                    <option value="604800">In 7 days</option>
                    <option value="2592000">In 30 days</option>
                    <option value="">Never</option>
                  </NativeSelect>
                </Field>
                <Field label="Download limit">
                  <Input type="number" min={1} value={oneTime ? '1' : maxDownloads} disabled={oneTime} onChange={(e) => setMaxDownloads(e.target.value)} placeholder="Unlimited" />
                </Field>
                <Field label="Allowed countries" hint="ISO codes; empty = anywhere.">
                  <ListInput upper value={countries} onChange={setCountries} placeholder="AU, NZ" />
                </Field>
                <Field label="Allowed IPs / networks">
                  <ListInput value={ips} onChange={setIps} placeholder="203.0.113.0/24" />
                </Field>
              </div>
              <Field label="Message (optional)">
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={2} />
              </Field>
              <div className="flex flex-wrap gap-4 text-[13px]">
                <label className="flex items-center gap-2">
                  <Checkbox checked={oneTime} onCheckedChange={(c) => setOneTime(c === true)} /> Download once, then destroy the link
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={requireEmail} onCheckedChange={(c) => setRequireEmail(c === true)} /> Ask for an email address
                </label>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                <Share2 /> Create link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SharesSection({ file }: { file: FileDTO }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const q = useQuery({ queryKey: ['file-shares', file.id], queryFn: () => api<{ data: ShareDTO[] }>('/shares', { query: { file_id: file.id, state: 'active', limit: 20 } }) });
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <Heading>Share links</Heading>
        <Button size="xs" variant="secondary" onClick={() => setOpen(true)} disabled={file.status !== 'READY'}>
          <Share2 /> Share
        </Button>
      </div>
      {q.data?.data.length ? (
        <div className="divide-y rounded-md border text-[13px]">
          {q.data.data.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-2">
              <code className="text-xs text-muted-foreground">/s/{s.token_prefix}…</code>
              <span className="flex-1 truncate text-xs">
                {[s.has_password && 'password', s.one_time && 'one-time', s.max_downloads && `${s.download_count}/${s.max_downloads}`, s.expires_at && `until ${formatDate(s.expires_at, false)}`].filter(Boolean).join(' · ') || 'open'}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  await api(`/shares/${s.id}/revoke`, { method: 'POST' });
                  void qc.invalidateQueries({ queryKey: ['file-shares', file.id] });
                }}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No active share links.</p>
      )}
      <ShareDialog file={file} open={open} onOpenChange={setOpen} />
    </section>
  );
}

// ─── Image transformations ───────────────────────────────────────────────────

const TRANSFORMABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff', 'image/heif', 'image/heic']);

export function ImageSection({ file }: { file: FileDTO }) {
  const [w, setW] = React.useState('800');
  const [h, setH] = React.useState('');
  const [fit, setFit] = React.useState('cover');
  const [format, setFormat] = React.useState('auto');
  const [q, setQ] = React.useState('80');
  const [extra, setExtra] = React.useState({ blur: '', sharpen: false, grayscale: false, rotate: '0', wm: '' });
  const [signed, setSigned] = React.useState<{ url: string; canonical: string } | null>(null);
  if (!TRANSFORMABLE.has(file.mime_type) || file.status !== 'READY') return null;
  const params = {
    ...(w ? { w: Number(w) } : {}),
    ...(h ? { h: Number(h) } : {}),
    fit,
    format,
    q: Number(q),
    ...(extra.blur ? { blur: Number(extra.blur) } : {}),
    ...(extra.sharpen ? { sharpen: 1 } : {}),
    ...(extra.grayscale ? { grayscale: true } : {}),
    ...(extra.rotate !== '0' ? { rotate: Number(extra.rotate) } : {}),
    ...(extra.wm ? { wm: extra.wm } : {}),
  };
  // Previews go through the same origin as the dashboard (CSP), with the signed query string.
  const preview = signed ? `${new URL(signed.url).pathname}${new URL(signed.url).search}` : null;
  return (
    <section>
      <Heading>Image optimisation</Heading>
      <div className="space-y-3 rounded-md border p-3">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Width">
            <Input type="number" min={1} value={w} onChange={(e) => setW(e.target.value)} />
          </Field>
          <Field label="Height">
            <Input type="number" min={1} value={h} onChange={(e) => setH(e.target.value)} placeholder="auto" />
          </Field>
          <Field label="Quality">
            <Input type="number" min={1} max={100} value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Fit">
            <NativeSelect className="w-full" value={fit} onChange={(e) => setFit(e.target.value)}>
              {['cover', 'contain', 'inside', 'outside', 'fill'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Format">
            <NativeSelect className="w-full" value={format} onChange={(e) => setFormat(e.target.value)}>
              {['auto', 'webp', 'avif', 'jpeg', 'png'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Rotate">
            <NativeSelect className="w-full" value={extra.rotate} onChange={(e) => setExtra((x) => ({ ...x, rotate: e.target.value }))}>
              {['0', '90', '180', '270'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Blur">
            <Input type="number" min={0.3} max={100} step="0.1" value={extra.blur} onChange={(e) => setExtra((x) => ({ ...x, blur: e.target.value }))} placeholder="off" />
          </Field>
          <Field label="Watermark file">
            <Input value={extra.wm} onChange={(e) => setExtra((x) => ({ ...x, wm: e.target.value.trim() }))} placeholder="file_…" className="font-mono text-xs" />
          </Field>
          <div className="space-y-1 pt-5 text-[13px]">
            <label className="flex items-center gap-2">
              <Checkbox checked={extra.sharpen} onCheckedChange={(c) => setExtra((x) => ({ ...x, sharpen: c === true }))} /> Sharpen
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={extra.grayscale} onCheckedChange={(c) => setExtra((x) => ({ ...x, grayscale: c === true }))} /> Greyscale
            </label>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              setSigned(await api('/images/sign', { body: { file_id: file.id, params } }));
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <ImageIcon /> Generate signed URL
        </Button>
        {signed && (
          <>
            <div className="flex items-center gap-2 rounded-md bg-subtle p-2">
              <code className="min-w-0 flex-1 truncate text-xs">{signed.url}</code>
              <CopyButton value={signed.url} label="Image URL copied" />
            </div>
            {preview && <img src={preview} alt="Transformed preview" className="mx-auto max-h-60 max-w-full rounded border object-contain" />}
          </>
        )}
      </div>
    </section>
  );
}

// ─── Media renditions ────────────────────────────────────────────────────────

interface Rendition {
  id: string;
  kind: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  error: string | null;
  mime_type: string | null;
  size: number;
  width: number | null;
  height: number | null;
  url: string | null;
}

function HlsPlayer({ src }: { src: string }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;
    void import('hls.js').then(({ default: Hls }) => {
      if (destroyed || !Hls.isSupported()) return;
      const h = new Hls();
      h.loadSource(src);
      h.attachMedia(video);
      hls = h;
    });
    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [src]);
  return <video ref={ref} controls className="max-h-64 w-full rounded bg-black" />;
}

const sameOrigin = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

export function MediaSection({ file }: { file: FileDTO }) {
  const { can } = useSession();
  const isMedia = file.mime_type.startsWith('video/') || file.mime_type.startsWith('audio/');
  const q = useQuery({
    queryKey: ['renditions', file.id],
    queryFn: () => api<{ data: Rendition[] }>(`/files/${file.id}/media`),
    enabled: isMedia,
    refetchInterval: (query) => (query.state.data?.data.some((r) => r.status === 'PENDING' || r.status === 'PROCESSING') ? 5000 : false),
  });
  if (!isMedia || file.status !== 'READY') return null;
  const hls = q.data?.data.find((r) => r.kind === 'hls' && r.status === 'READY');
  const thumb = q.data?.data.find((r) => r.kind === 'thumbnail' && r.status === 'READY');
  const wave = q.data?.data.find((r) => r.kind === 'waveform' && r.status === 'READY');
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <Heading>Streaming & renditions</Heading>
        {can('files.edit') && (
          <Button
            size="xs"
            variant="secondary"
            onClick={async () => {
              try {
                await api(`/files/${file.id}/media/process`, { body: {} });
                toast.success('Rendition jobs queued');
                void q.refetch();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            {q.data?.data.length ? <RefreshCw /> : <Play />} {q.data?.data.length ? 'Re-process' : 'Generate'}
          </Button>
        )}
      </div>
      {hls?.url && <HlsPlayer src={sameOrigin(hls.url)} />}
      {!hls && thumb?.url && <img src={sameOrigin(thumb.url)} alt="Video thumbnail" className="max-h-48 rounded border" />}
      {wave?.url && <img src={sameOrigin(wave.url)} alt="Audio waveform" className="mt-2 w-full rounded border bg-subtle" />}
      <div className="mt-2 divide-y rounded-md border text-[13px]">
        {(q.data?.data ?? []).map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="w-24 font-mono text-xs">{r.kind}</span>
            <StatusDot status={healthTone(r.status)} label={r.status.toLowerCase()} />
            <span className="flex-1 truncate text-xs text-muted-foreground" title={r.error ?? undefined}>
              {r.error ?? [r.width && r.height ? `${r.width}×${r.height}` : null, r.size ? formatBytes(r.size) : null].filter(Boolean).join(' · ')}
            </span>
            {r.url && <CopyButton value={r.url} label={`${r.kind} URL copied`} />}
          </div>
        ))}
        {q.data && q.data.data.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No renditions yet. Enable video processing on the zone or in Settings, or generate them now.</p>}
      </div>
    </section>
  );
}

// ─── Cache & lifecycle ───────────────────────────────────────────────────────

interface CacheInfo {
  zone: { id: string; name: string } | null;
  path: string;
  policy: { cacheControl: string; cdnCacheControl: string | null; edgeTtl: number; browserTtl: number; bypass: boolean; rule: { name: string; pattern: string } | null; tags: string[]; source: string };
  urls: string[];
}

export function CacheSection({ file, onChanged }: { file: FileDTO; onChanged: () => void }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['file-cache', file.id, file.updated_at], queryFn: () => api<CacheInfo>(`/files/${file.id}/cache`) });
  const [tags, setTags] = React.useState(file.cache_tags);
  const [expires, setExpires] = React.useState(file.expires_at ? file.expires_at.slice(0, 16) : '');
  React.useEffect(() => {
    setTags(file.cache_tags);
    setExpires(file.expires_at ? file.expires_at.slice(0, 16) : '');
  }, [file]);
  const save = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/files/${file.id}`, { method: 'PATCH', body });
      toast.success(msg);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const p = q.data?.policy;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <Heading>Delivery & cache</Heading>
        {can('cache.purge') && (
          <Button
            size="xs"
            variant="secondary"
            onClick={async () => {
              try {
                await api('/cache/purge', { body: { type: 'file', targets: [file.id] } });
                toast.success('Purge queued');
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Zap /> Purge
          </Button>
        )}
      </div>
      {p && (
        <KeyValue
          items={[
            ['Zone', q.data!.zone ? q.data!.zone.name : 'none'],
            ['Edge / browser', p.bypass ? <Badge key="b" tone="warning">bypass</Badge> : `${formatTtl(p.edgeTtl)} / ${formatTtl(p.browserTtl)}${p.rule ? ` (rule “${p.rule.name}”)` : ''}`],
            ['Cache-Control', <code key="cc" className="text-xs">{p.cacheControl}</code>],
            ['URLs', <div key="u" className="space-y-0.5">{q.data!.urls.map((u) => <div key={u} className="flex items-center gap-1"><code className="truncate text-[11px]">{u}</code><CopyButton value={u} /></div>)}</div>],
          ]}
        />
      )}
      {can('files.edit') && (
        <div className={cn('mt-3 grid gap-3 sm:grid-cols-2')}>
          <Field label="Cache tags" hint="Purge many files at once by tag.">
            <div className="flex gap-2">
              <ListInput value={tags} onChange={setTags} placeholder="release:v2" />
              <Button type="button" size="sm" variant="secondary" onClick={() => save({ cache_tags: tags }, 'Cache tags saved')}>
                Save
              </Button>
            </div>
          </Field>
          <Field label="Expires" hint="Moved to the recycle bin at this time.">
            <div className="flex gap-2">
              <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
              <Button type="button" size="sm" variant="secondary" onClick={() => save({ expires_at: expires ? new Date(expires).toISOString() : null }, expires ? 'Expiry set' : 'Expiry removed')}>
                Save
              </Button>
            </div>
          </Field>
        </div>
      )}
    </section>
  );
}
