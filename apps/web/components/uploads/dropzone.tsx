'use client';
import * as React from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Dropzone({ onFiles, className, compact }: { onFiles: (files: File[]) => void; className?: string; compact?: boolean }) {
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed text-center transition-colors hover:bg-subtle',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        over && 'border-primary bg-[hsl(var(--primary)/0.05)]',
        className,
      )}
    >
      <UploadCloud className="mb-2 h-7 w-7 text-muted-foreground" />
      <p className="text-sm font-medium">Drop files here or click to browse</p>
      <p className="mt-1 text-xs text-muted-foreground">Multiple files supported · large files are uploaded in resumable chunks</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
