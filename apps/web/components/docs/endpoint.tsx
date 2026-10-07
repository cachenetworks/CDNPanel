'use client';
import * as React from 'react';
import { Play, ShieldAlert } from 'lucide-react';
import { getCsrfToken } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Input, NativeSelect, Textarea } from '../ui/form';
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/misc';
import { CodeBlock, MethodBadge } from './code';

/* Minimal OpenAPI typings for what the reference renders. */
export interface OaParam {
  name: string;
  in: 'path' | 'query';
  required?: boolean;
  description?: string;
  schema?: { type?: string | string[]; enum?: unknown[]; default?: unknown; format?: string };
}
export interface OaOperation {
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  parameters?: OaParam[];
  requestBody?: { content: Record<string, { schema?: { properties?: Record<string, { type?: string; description?: string; enum?: string[]; format?: string }>; required?: string[] }; example?: unknown }> };
  responses: Record<string, { description: string; content?: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }> }>;
  'x-auth-mode': 'public' | 'session' | 'any';
  'x-required-permissions': string[];
  'x-required-scopes': string[];
  'x-requires-reauthentication'?: boolean;
  'x-rate-limit'?: { max: number; window_seconds: number };
  'x-codeSamples': { lang: string; label: string; source: string }[];
}
export interface EndpointEntry {
  method: string;
  path: string;
  op: OaOperation;
}

function typeLabel(s?: OaParam['schema']) {
  if (!s) return '';
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join(' | ') : s.type;
  return s.enum ? s.enum.map(String).join(' | ') : (t ?? '');
}

function ParamTable({ rows }: { rows: { name: string; type: string; required?: boolean; description?: string; location?: string }[] }) {
  return (
    <div className="mb-4 overflow-hidden rounded-md border">
      <table className="w-full text-[13px]">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.location}-${r.name}`} className="border-b align-top last:border-0">
              <td className="w-48 px-3 py-2">
                <span className="font-mono text-xs">{r.name}</span>
                {r.required && <span className="ml-1 text-[10px] font-medium text-destructive">required</span>}
                <div className="text-[11px] text-muted-foreground">
                  {r.location ? `${r.location} · ` : ''}
                  {r.type}
                </div>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{r.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Try It: requests are sent from the browser. A supplied API key lives only in React state (memory). */
function TryIt({ entry, apiKey, setApiKey }: { entry: EndpointEntry; apiKey: string; setApiKey: (k: string) => void }) {
  const { op, method, path } = entry;
  const params = op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  const jsonBody = op.requestBody?.content['application/json'];
  const multipart = op.requestBody?.content['multipart/form-data'];
  const raw = op.requestBody?.content['application/octet-stream'];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [body, setBody] = React.useState(jsonBody?.example ? JSON.stringify(jsonBody.example, null, 2) : '');
  const [file, setFile] = React.useState<File | null>(null);
  const [authMode, setAuthMode] = React.useState<'key' | 'session' | 'none'>(op['x-auth-mode'] === 'session' ? 'session' : op['x-auth-mode'] === 'public' ? 'none' : 'key');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ status: number; ms: number; headers: [string, string][]; body: string } | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    const started = performance.now();
    try {
      let url = path.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(values[`path.${n}`] ?? ''));
      const qs = new URLSearchParams();
      for (const p of queryParams) if (values[`query.${p.name}`]) qs.set(p.name, values[`query.${p.name}`]!);
      if (qs.toString()) url += `?${qs}`;
      const headers: Record<string, string> = {};
      let reqBody: BodyInit | undefined;
      if (authMode === 'key' && apiKey) headers.Authorization = `Bearer ${apiKey.trim()}`;
      if (authMode === 'session' && method !== 'get') headers['X-CSRF-Token'] = getCsrfToken() ?? '';
      if (multipart) {
        const form = new FormData();
        for (const [name] of Object.entries(multipart.schema?.properties ?? {})) if (name !== 'file' && values[`form.${name}`]) form.append(name, values[`form.${name}`]!);
        if (file) form.append('file', file, file.name);
        reqBody = form;
      } else if (raw) {
        headers['Content-Type'] = 'application/octet-stream';
        reqBody = file ?? new Blob([]);
      } else if (jsonBody && body.trim()) {
        headers['Content-Type'] = 'application/json';
        reqBody = body;
      }
      const res = await fetch(url, { method: method.toUpperCase(), headers, body: reqBody, credentials: authMode === 'session' ? 'same-origin' : 'omit' });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        if ((res.headers.get('content-type') ?? '').match(/^(image|video|audio|application\/octet)/)) pretty = `<${text.length} bytes of ${res.headers.get('content-type')}>`;
      }
      const shown = ['content-type', 'content-length', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'etag', 'cache-control', 'content-range'];
      setResult({ status: res.status, ms: Math.round(performance.now() - started), headers: shown.filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)!]), body: pretty.slice(0, 20000) });
    } catch (err) {
      setResult({ status: 0, ms: 0, headers: [], body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect className="h-8 text-xs" value={authMode} onChange={(e) => setAuthMode(e.target.value as typeof authMode)} aria-label="Authentication">
          <option value="key">API key</option>
          <option value="session">My dashboard session</option>
          <option value="none">No authentication</option>
        </NativeSelect>
        {authMode === 'key' && (
          <Input
            className="h-8 max-w-sm flex-1 font-mono text-xs"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="cdn_live_… (kept in memory only)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            data-1p-ignore
            data-lpignore="true"
          />
        )}
      </div>
      {authMode === 'key' && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5" /> The key is held in this tab’s memory only — never saved to storage, logs or analytics. Reloading clears it.
        </p>
      )}
      {[...pathParams.map((p) => ({ ...p, key: `path.${p.name}` })), ...queryParams.map((p) => ({ ...p, key: `query.${p.name}` }))].map((p) => (
        <label key={p.key} className="grid grid-cols-[160px_1fr] items-center gap-2 text-xs">
          <span className="font-mono">
            {p.name}
            {p.required && <span className="text-destructive">*</span>}
            <span className="ml-1 text-muted-foreground">({p.in})</span>
          </span>
          {p.schema?.enum ? (
            <NativeSelect className="h-8 text-xs" value={values[p.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}>
              <option value="">—</option>
              {p.schema.enum.map((o) => (
                <option key={String(o)}>{String(o)}</option>
              ))}
            </NativeSelect>
          ) : (
            <Input className="h-8 text-xs" value={values[p.key] ?? ''} placeholder={p.schema?.default !== undefined ? String(p.schema.default) : ''} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
          )}
        </label>
      ))}
      {multipart &&
        Object.entries(multipart.schema?.properties ?? {})
          .filter(([n]) => n !== 'file')
          .map(([name]) => (
            <label key={name} className="grid grid-cols-[160px_1fr] items-center gap-2 text-xs">
              <span className="font-mono">{name} (form)</span>
              <Input className="h-8 text-xs" value={values[`form.${name}`] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [`form.${name}`]: e.target.value }))} />
            </label>
          ))}
      {(multipart || raw) && (
        <label className="grid grid-cols-[160px_1fr] items-center gap-2 text-xs">
          <span className="font-mono">{raw ? 'chunk' : 'file'}</span>
          <input type="file" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      {jsonBody && <Textarea className="min-h-[120px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} aria-label="Request body" />}
      <Button size="sm" onClick={send} loading={busy}>
        <Play /> Send request
      </Button>
      {result && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs">
            <Badge tone={result.status >= 200 && result.status < 300 ? 'success' : result.status >= 400 || result.status === 0 ? 'danger' : 'warning'}>{result.status || 'Network error'}</Badge>
            <span className="text-muted-foreground tabular">{result.ms} ms</span>
          </div>
          {result.headers.length > 0 && <CodeBlock code={result.headers.map(([k, v]) => `${k}: ${v}`).join('\n')} language="headers" />}
          <CodeBlock code={result.body || '(empty body)'} language="response" />
        </div>
      )}
    </div>
  );
}

export function Endpoint({ entry, apiKey, setApiKey, canTry }: { entry: EndpointEntry; apiKey: string; setApiKey: (k: string) => void; canTry: boolean }) {
  const { op, method, path } = entry;
  const [showTry, setShowTry] = React.useState(false);
  const params = op.parameters ?? [];
  const content = op.requestBody?.content ?? {};
  const [ct, media] = Object.entries(content)[0] ?? [];
  const bodyRows = Object.entries(media?.schema?.properties ?? {}).map(([name, s]) => ({
    name,
    type: s.enum ? s.enum.join(' | ') : s.format === 'binary' ? 'file' : (s.type ?? 'any'),
    required: media?.schema?.required?.includes(name),
    description: s.description,
  }));
  const success = Object.entries(op.responses).filter(([s]) => Number(s) < 400);
  const errors = Object.entries(op.responses).filter(([s]) => Number(s) >= 400);
  const errorCodes = errors.flatMap(([status, r]) => Object.keys(r.content?.['application/json']?.examples ?? {}).map((code) => ({ status, code })));
  const anchor = op.operationId;

  return (
    <article id={anchor} className="scroll-mt-20 border-b py-8 last:border-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <MethodBadge method={method} />
        <code className="font-mono text-[13px] font-medium">{path}</code>
      </div>
      <h3 className="text-base font-semibold">{op.summary}</h3>
      {op.description && op.description !== op.summary && <p className="mt-1 max-w-3xl whitespace-pre-line text-sm leading-6 text-muted-foreground">{op.description.replace(/\*\*/g, '').replace(/`/g, '')}</p>}

      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <Badge tone="outline">{op['x-auth-mode'] === 'public' ? 'No authentication' : op['x-auth-mode'] === 'session' ? 'Staff session only' : 'API key or staff session'}</Badge>
        {op['x-required-scopes'].map((s) => (
          <Badge key={s} tone="info">
            scope: {s}
          </Badge>
        ))}
        {op['x-required-permissions'].map((p) => (
          <Badge key={p}>permission: {p}</Badge>
        ))}
        {op['x-requires-reauthentication'] && <Badge tone="warning">requires re-authentication</Badge>}
        {op['x-rate-limit'] && (
          <Badge tone="outline">
            limit: {op['x-rate-limit'].max}/{op['x-rate-limit'].window_seconds}s
          </Badge>
        )}
      </div>

      <div className="mt-5 grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          {params.length > 0 && (
            <>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters</h4>
              <ParamTable rows={params.map((p) => ({ name: p.name, type: typeLabel(p.schema), required: p.required, description: p.description, location: p.in }))} />
            </>
          )}
          {ct && (
            <>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Body <span className="normal-case">({ct})</span>
              </h4>
              {bodyRows.length ? <ParamTable rows={bodyRows} /> : <p className="mb-4 text-sm text-muted-foreground">Raw bytes.</p>}
            </>
          )}
          {errorCodes.length > 0 && (
            <>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Errors</h4>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {errorCodes.map((e) => (
                  <span key={e.code} className="rounded border px-1.5 py-0.5 font-mono text-[11px]">
                    {e.status} {e.code}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="min-w-0">
          <Tabs defaultValue={op['x-codeSamples'][0]?.label}>
            <TabsList>
              {op['x-codeSamples'].map((s) => (
                <TabsTrigger key={s.label} value={s.label}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {op['x-codeSamples'].map((s) => (
              <TabsContent key={s.label} value={s.label} className="pt-2">
                <CodeBlock code={s.source} language={s.lang} />
              </TabsContent>
            ))}
          </Tabs>
          {success.map(([status, r]) => {
            const example = Object.values(r.content ?? {})[0]?.example;
            return (
              <div key={status}>
                <p className="mb-1 text-xs text-muted-foreground">
                  <span className={cn('font-mono font-semibold', 'text-success')}>{status}</span> {r.description}
                </p>
                {example !== undefined && <CodeBlock code={JSON.stringify(example, null, 2)} language="json" />}
              </div>
            );
          })}
        </div>
      </div>

      {canTry && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" onClick={() => setShowTry((s) => !s)}>
            <Play /> {showTry ? 'Hide' : 'Try it'}
          </Button>
          {showTry && (
            <div className="mt-3">
              <TryIt entry={entry} apiKey={apiKey} setApiKey={setApiKey} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
