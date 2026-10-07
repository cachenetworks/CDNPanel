'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/form';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { GUIDES } from '@/components/docs/guides';
import { Endpoint, type EndpointEntry, type OaOperation } from '@/components/docs/endpoint';
import { MethodBadge } from '@/components/docs/code';

interface OpenApiDoc {
  servers: { url: string }[];
  paths: Record<string, Record<string, OaOperation>>;
  'x-scopes': Record<string, string>;
  'x-errors': Record<string, { status: number; message: string }>;
}

/** Sidebar sections: guide id → OpenAPI tags rendered under it. */
const SECTIONS: { id: string; tags: string[] }[] = [
  { id: 'introduction', tags: [] },
  { id: 'authentication', tags: ['Account', 'Authentication'] },
  { id: 'quick-start', tags: [] },
  { id: 'files', tags: ['Files', 'Delivery'] },
  { id: 'uploads', tags: ['Uploads'] },
  { id: 'folders', tags: ['Folders'] },
  { id: 'signed-urls', tags: ['Signed URLs'] },
  { id: 'api-keys', tags: ['API Keys'] },
  { id: 'analytics', tags: ['Analytics'] },
  { id: 'webhooks', tags: ['Webhooks'] },
  { id: 'errors', tags: [] },
  { id: 'rate-limits', tags: [] },
];
const ADMIN_TAGS = ['Users', 'Roles', 'Security', 'Audit Logs', 'Settings', 'Storage', 'Dashboard', 'Health'];

export default function DocsPage() {
  const { can } = useSession();
  // API key for "Try it" lives in component state only (never persisted).
  const [apiKey, setApiKey] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState('introduction');
  const q = useQuery({
    queryKey: ['openapi'],
    queryFn: async () => {
      const res = await fetch('/openapi.json');
      if (!res.ok) throw new Error(`Could not load the API specification (${res.status})`);
      return (await res.json()) as OpenApiDoc;
    },
    staleTime: 5 * 60_000,
  });

  const endpoints = React.useMemo<EndpointEntry[]>(() => {
    if (!q.data) return [];
    return Object.entries(q.data.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ method, path, op })));
  }, [q.data]);

  const origin = typeof window !== 'undefined' ? window.location.origin : (q.data?.servers[0]?.url ?? '');
  const needle = query.trim().toLowerCase();
  const matchesEndpoint = (e: EndpointEntry) => !needle || `${e.method} ${e.path} ${e.op.summary} ${e.op.description ?? ''} ${e.op['x-required-scopes'].join(' ')}`.toLowerCase().includes(needle);
  const byTag = (tags: string[]) => endpoints.filter((e) => tags.includes(e.op.tags[0] ?? '') && matchesEndpoint(e));

  const visibleSections = SECTIONS.map((s) => {
    const guide = GUIDES.find((g) => g.id === s.id)!;
    const guideMatch = !needle || `${guide.title} ${guide.text}`.toLowerCase().includes(needle);
    const eps = byTag(s.tags);
    return { ...s, guide, guideMatch, eps };
  }).filter((s) => s.guideMatch || s.eps.length > 0);
  const adminEps = byTag(ADMIN_TAGS);

  React.useEffect(() => {
    const handler = () => {
      const ids = [...visibleSections.map((s) => s.id), ...(adminEps.length ? ['administration'] : [])];
      let current = ids[0] ?? 'introduction';
      for (const id of ids) {
        const el = document.getElementById(`section-${id}`);
        if (el && el.getBoundingClientRect().top < 120) current = id;
      }
      setActive(current);
    };
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  });

  return (
    <div className="flex gap-8">
      <aside className="sticky top-20 hidden h-[calc(100vh-6rem)] w-56 shrink-0 overflow-y-auto lg:block">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-xs" placeholder="Search docs…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <nav className="space-y-0.5 text-[13px]">
          {visibleSections.map((s) => (
            <div key={s.id}>
              <a href={`#section-${s.id}`} className={cn('block rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', active === s.id && 'bg-accent font-medium text-foreground')}>
                {s.guide.title}
              </a>
              {needle &&
                s.eps.map((e) => (
                  <a key={e.op.operationId} href={`#${e.op.operationId}`} className="flex items-center gap-1.5 truncate rounded py-0.5 pl-4 text-[11px] text-muted-foreground hover:text-foreground">
                    <span className="font-mono uppercase">{e.method}</span> {e.path}
                  </a>
                ))}
            </div>
          ))}
          {adminEps.length > 0 && (
            <a href="#section-administration" className={cn('block rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground', active === 'administration' && 'bg-accent font-medium text-foreground')}>
              Administration API
            </a>
          )}
        </nav>
        <a href="/openapi.json" target="_blank" rel="noreferrer" className="mt-4 block px-2 text-xs text-primary hover:underline">
          openapi.json ↗
        </a>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">API Documentation</h1>
          <p className="mt-1 text-sm text-muted-foreground">Generated from the live OpenAPI specification. Every endpoint lists its permissions, parameters, examples and error codes.</p>
          <div className="relative mt-3 lg:hidden">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search docs…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.isLoading ? (
          <Skeleton className="h-96" />
        ) : (
          q.data && (
            <>
              {visibleSections.length === 0 && adminEps.length === 0 && <p className="text-sm text-muted-foreground">No results for “{query}”.</p>}
              {visibleSections.map((s) => (
                <section key={s.id} id={`section-${s.id}`} className="mb-10 scroll-mt-20">
                  <h2 className="mb-3 border-b pb-2 text-lg font-semibold">{s.guide.title}</h2>
                  {s.guideMatch && s.guide.render({ origin, scopes: q.data['x-scopes'], errors: q.data['x-errors'] })}
                  {s.eps.length > 0 && !needle && (
                    <div className="mb-2 mt-4 overflow-hidden rounded-md border">
                      {s.eps.map((e) => (
                        <a key={e.op.operationId} href={`#${e.op.operationId}`} className="flex items-center gap-3 border-b px-3 py-1.5 text-[13px] last:border-0 hover:bg-subtle">
                          <MethodBadge method={e.method} />
                          <code className="font-mono text-xs">{e.path}</code>
                          <span className="truncate text-muted-foreground">{e.op.summary}</span>
                        </a>
                      ))}
                    </div>
                  )}
                  {s.eps.map((e) => (
                    <Endpoint key={e.op.operationId} entry={e} apiKey={apiKey} setApiKey={setApiKey} canTry={can('files.view')} />
                  ))}
                </section>
              ))}
              {adminEps.length > 0 && (
                <section id="section-administration" className="mb-10 scroll-mt-20">
                  <h2 className="mb-1 border-b pb-2 text-lg font-semibold">Administration API</h2>
                  <p className="mt-2 text-sm text-muted-foreground">These endpoints power the dashboard and require a staff session with the listed permission. They cannot be called with API keys.</p>
                  {adminEps.map((e) => (
                    <Endpoint key={e.op.operationId} entry={e} apiKey={apiKey} setApiKey={setApiKey} canTry />
                  ))}
                </section>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
