'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { CopyButton } from '../ui/misc';

export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <div className={cn('group relative mb-3 overflow-hidden rounded-md border bg-[hsl(240_10%_6%)] text-[hsl(0_0%_92%)]', className)}>
      {language && <div className="border-b border-white/10 px-3 py-1 text-[11px] text-white/50">{language}</div>}
      <div className="absolute right-1.5 top-1 opacity-0 group-hover:opacity-100 [&_button]:text-white/70 [&_button:hover]:bg-white/10">
        <CopyButton value={code} label="Copied" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-5">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const tone =
    m === 'GET' ? 'bg-[hsl(var(--primary)/0.12)] text-primary' : m === 'POST' ? 'bg-[hsl(var(--success)/0.14)] text-success' : m === 'DELETE' ? 'bg-[hsl(var(--destructive)/0.12)] text-destructive' : 'bg-[hsl(var(--warning)/0.14)] text-warning';
  return <span className={cn('inline-flex w-14 justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold', tone)}>{m}</span>;
}
