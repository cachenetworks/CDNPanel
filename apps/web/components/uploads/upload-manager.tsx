'use client';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage, xhrUpload } from '@/lib/api';
import type { FileDTO, Visibility } from '@/lib/types';

/**
 * Client-side upload queue: concurrent uploads, progress, speed, retry.
 * Files up to DIRECT_LIMIT go through a single multipart request; larger files use the
 * resumable chunked API (init → chunks → complete), retrying individual chunks.
 */
const DIRECT_LIMIT = 64 * 1024 * 1024;
const CONCURRENCY = 3;
const CHUNK_RETRIES = 3;

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'complete' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  folderId: string | null;
  folderLabel: string;
  visibility?: Visibility;
  status: UploadStatus;
  loaded: number;
  speed: number;
  error?: string;
  result?: FileDTO;
  startedAt?: number;
  controller?: AbortController;
}

interface UploadContextValue {
  items: UploadItem[];
  activeCount: number;
  enqueue: (files: File[], opts: { folderId: string | null; folderLabel?: string; visibility?: Visibility }) => void;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  clearFinished: () => void;
}

const UploadContext = React.createContext<UploadContextValue | null>(null);

export function useUploads(): UploadContextValue {
  const ctx = React.useContext(UploadContext);
  if (!ctx) throw new Error('useUploads must be used inside UploadProvider');
  return ctx;
}

async function uploadDirect(item: UploadItem, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<FileDTO> {
  const form = new FormData();
  if (item.folderId) form.append('folder_id', item.folderId);
  if (item.visibility) form.append('visibility', item.visibility);
  form.append('file', item.file, item.file.name);
  return xhrUpload<FileDTO>('/api/v1/files', form, { onProgress: (l) => onProgress(l), signal });
}

async function uploadChunked(item: UploadItem, onProgress: (loaded: number) => void, onProcessing: () => void, signal: AbortSignal): Promise<FileDTO> {
  const init = await api<{ id: string; chunk_size: number; total_chunks: number; received_chunks: number[] }>('/uploads/init', {
    body: { filename: item.file.name, size: item.file.size, folder_id: item.folderId, ...(item.visibility ? { visibility: item.visibility } : {}) },
    signal,
  });
  const done = new Set(init.received_chunks);
  let confirmed = 0;
  for (let i = 0; i < init.total_chunks; i++) {
    if (done.has(i)) {
      confirmed += Math.min(init.chunk_size, item.file.size - i * init.chunk_size);
      continue;
    }
    const blob = item.file.slice(i * init.chunk_size, Math.min(item.file.size, (i + 1) * init.chunk_size));
    let attempt = 0;
    for (;;) {
      try {
        await xhrUpload(`/api/v1/uploads/${init.id}/chunk?index=${i}`, blob, {
          headers: { 'Content-Type': 'application/octet-stream' },
          onProgress: (l) => onProgress(confirmed + l),
          signal,
        });
        break;
      } catch (err) {
        if (signal.aborted || (err instanceof ApiError && err.status >= 400 && err.status < 500) || ++attempt >= CHUNK_RETRIES) {
          if (signal.aborted) await api(`/uploads/${init.id}`, { method: 'DELETE' }).catch(() => undefined);
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    confirmed += blob.size;
    onProgress(confirmed);
  }
  onProcessing();
  return api<FileDTO>(`/uploads/${init.id}/complete`, { method: 'POST', signal });
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const running = React.useRef(new Set<string>());
  const qc = useQueryClient();

  const patch = React.useCallback((id: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const start = React.useCallback(
    async (item: UploadItem) => {
      running.current.add(item.id);
      const controller = new AbortController();
      const startedAt = Date.now();
      patch(item.id, { status: 'uploading', loaded: 0, speed: 0, error: undefined, startedAt, controller });
      let lastTick = startedAt;
      let lastLoaded = 0;
      const onProgress = (loaded: number) => {
        const now = Date.now();
        if (now - lastTick < 250 && loaded < item.file.size) return;
        const speed = ((loaded - lastLoaded) / Math.max(1, now - lastTick)) * 1000;
        lastTick = now;
        lastLoaded = loaded;
        patch(item.id, { loaded, speed: Math.max(0, speed), status: loaded >= item.file.size ? 'processing' : 'uploading' });
      };
      try {
        const result =
          item.file.size > DIRECT_LIMIT
            ? await uploadChunked(item, onProgress, () => patch(item.id, { status: 'processing' }), controller.signal)
            : await uploadDirect(item, onProgress, controller.signal);
        patch(item.id, { status: 'complete', loaded: item.file.size, result, controller: undefined });
        void qc.invalidateQueries({ queryKey: ['files'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
      } catch (err) {
        const cancelled = controller.signal.aborted;
        patch(item.id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Cancelled' : errorMessage(err), controller: undefined });
        if (!cancelled) toast.error(`${item.file.name}: ${errorMessage(err)}`);
      } finally {
        running.current.delete(item.id);
        // Re-run the scheduler now that a slot is free.
        setItems((prev) => [...prev]);
      }
    },
    [patch, qc],
  );

  // Scheduler: keep up to CONCURRENCY uploads running.
  React.useEffect(() => {
    const free = CONCURRENCY - running.current.size;
    if (free <= 0) return;
    items
      .filter((it) => it.status === 'queued' && !running.current.has(it.id))
      .slice(0, free)
      .forEach((it) => void start(it));
  }, [items, start]);

  const value = React.useMemo<UploadContextValue>(
    () => ({
      items,
      activeCount: items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'processing').length,
      enqueue: (files, opts) =>
        setItems((prev) => [
          ...files.map((file) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
            folderId: opts.folderId,
            folderLabel: opts.folderLabel ?? '/',
            visibility: opts.visibility,
            status: 'queued' as const,
            loaded: 0,
            speed: 0,
          })),
          ...prev,
        ]),
      retry: (id) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'queued', error: undefined, loaded: 0 } : it))),
      cancel: (id) =>
        setItems((prev) =>
          prev.map((it) => {
            if (it.id !== id) return it;
            it.controller?.abort();
            return it.status === 'queued' ? { ...it, status: 'cancelled', error: 'Cancelled' } : it;
          }),
        ),
      clearFinished: () => setItems((prev) => prev.filter((it) => it.status === 'queued' || it.status === 'uploading' || it.status === 'processing')),
    }),
    [items],
  );

  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (value.activeCount > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [value.activeCount]);

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}
