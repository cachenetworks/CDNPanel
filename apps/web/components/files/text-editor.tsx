'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { RotateCcw, Save, WrapText, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge, Spinner } from '../ui/misc';
import { useConfirm } from '../confirm';

// CodeMirror and its language packs load only when the editor opens.
const CodeEditor = dynamic(() => import('./code-editor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  ),
});

interface TextFile {
  id: string;
  name: string;
  mime_type: string;
  version: number;
  size: number;
  content: string;
  max_bytes: number;
}

function useDarkMode(): boolean {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains('dark'));
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Full-screen editor for text files. Saving creates a new revision (same id and URLs). */
export function TextEditorDialog({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const dark = useDarkMode();
  const [file, setFile] = React.useState<TextFile | null>(null);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [wrap, setWrap] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!fileId) return;
    setFile(null);
    setError(null);
    try {
      const f = await api<TextFile>(`/files/${fileId}/text`);
      setFile(f);
      setText(f.content);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [fileId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = file !== null && text !== file.content;
  const bytes = React.useMemo(() => new TextEncoder().encode(text).length, [text]);
  const tooBig = file !== null && bytes > file.max_bytes;

  // Warn before leaving the page with unsaved edits.
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = React.useCallback(async () => {
    if (!file || !dirty || saving || tooBig) return;
    setSaving(true);
    try {
      await api(`/files/${file.id}/text`, { method: 'PUT', body: { content: text, base_version: file.version } });
      toast.success(`Saved ${file.name} as revision v${file.version + 1}`);
      setFile({ ...file, content: text, version: file.version + 1, size: bytes });
      void qc.invalidateQueries({ queryKey: ['file', file.id] });
      void qc.invalidateQueries({ queryKey: ['files'] });
      void qc.invalidateQueries({ queryKey: ['versions', file.id] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        confirm({
          title: 'This file changed while you were editing',
          description: `${errorMessage(err)} Reloading discards your edits; copy them first if you need them.`,
          confirmLabel: 'Reload latest',
          destructive: true,
          action: async () => {
            await load();
          },
        });
      } else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [file, dirty, saving, tooBig, text, bytes, qc, confirm, load]);

  const close = () => {
    if (!dirty) return onClose();
    confirm({ title: 'Discard unsaved changes?', description: 'Your edits have not been saved.', confirmLabel: 'Discard', destructive: true, action: async () => onClose() });
  };

  return (
    <DialogPrimitive.Root open={Boolean(fileId)} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl sm:inset-6"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            close();
          }}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {file?.name ?? 'Edit file'} {dirty && <span className="text-muted-foreground">•</span>}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Text editor. Saving creates a new revision of the file.</DialogPrimitive.Description>
            {file && (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                v{file.version} · {file.mime_type} · <span className={tooBig ? 'text-destructive' : ''}>{formatBytes(bytes)}</span>
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)} aria-pressed={wrap} title="Wrap long lines">
              <WrapText /> {wrap ? 'Wrap on' : 'Wrap off'}
            </Button>
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => file && setText(file.content)} title="Undo all changes">
              <RotateCcw /> Revert
            </Button>
            <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty || tooBig} title="Save (Ctrl+S)">
              <Save /> Save
            </Button>
            <button type="button" onClick={close} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="max-w-md text-sm text-destructive">{error}</p>
                <Button size="sm" variant="secondary" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : !file ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <CodeEditor value={text} onChange={setText} filename={file.name} wrap={wrap} dark={dark} onSave={() => void save()} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground">
            <span>Saving keeps the file&apos;s URLs and stores the previous content as a revision you can restore.</span>
            {tooBig && file && <Badge tone="danger">Over the {formatBytes(file.max_bytes)} editor limit</Badge>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
