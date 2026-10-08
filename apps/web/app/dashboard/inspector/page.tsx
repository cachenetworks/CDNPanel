'use client';
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, ScanSearch, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Badge, EmptyState, PageHeader, Panel, Section } from '@/components/ui/misc';

interface Step {
  stage: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

interface Result {
  url: string;
  verdict: 'served' | 'denied' | 'not_found' | 'challenge';
  steps: Step[];
  headers: Record<string, string>;
  live?: { status?: number; ttfb_ms?: number; total_ms: number; headers?: Record<string, string>; edge_cache?: string | null; error?: string };
}

const STAGE_LABEL: Record<string, string> = {
  parse: 'URL',
  host: 'Host',
  route: 'Route',
  share: 'Share link',
  file: 'File',
  zone: 'Zone',
  security: 'Edge security',
  auth: 'Authorization',
  transform: 'Transformation',
  storage: 'Storage',
  cache: 'Cache',
  content: 'Content',
  timing: 'Timing',
};

const VERDICT: Record<Result['verdict'], { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  served: { label: 'Served', tone: 'success' },
  denied: { label: 'Denied', tone: 'danger' },
  not_found: { label: '404 Not found', tone: 'neutral' },
  challenge: { label: 'Browser challenge', tone: 'warning' },
};

function StepIcon({ status }: { status: Step['status'] }) {
  const cls = 'h-4 w-4 shrink-0';
  if (status === 'ok') return <CheckCircle2 className={cn(cls, 'text-[hsl(var(--success))]')} aria-label="Passed" />;
  if (status === 'warn') return <AlertTriangle className={cn(cls, 'text-warning')} aria-label="Warning" />;
  if (status === 'fail') return <XCircle className={cn(cls, 'text-destructive')} aria-label="Failed" />;
  return <Info className={cn(cls, 'text-muted-foreground')} aria-label="Info" />;
}

function Headers({ title, headers }: { title: string; headers: Record<string, string> }) {
  return (
    <Panel className="overflow-hidden">
      <div className="border-b bg-subtle px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        {Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')}
      </pre>
    </Panel>
  );
}

export default function InspectorPage() {
  const [url, setUrl] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [referer, setReferer] = React.useState('');
  const [authenticated, setAuthenticated] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setResult(await api<Result>('/ops/inspect', { body: { url: url.trim(), country: country.trim().toUpperCase() || null, referer: referer.trim() || undefined, authenticated, live } }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Asset Inspector" description="Paste any CDN URL to see exactly how it is handled: zone, security decision, authorization, storage source, cache policy, transformations and response headers." />
      <Panel className="mb-6 p-4">
        <form onSubmit={run} className="space-y-4">
          <Field label="URL">
            <div className="flex gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://assets.example.com/img/logo.png?w=800&format=webp&s=…" required type="url" className="font-mono text-xs" autoFocus />
              <Button type="submit" loading={busy}>
                <ScanSearch /> Inspect
              </Button>
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Visitor country" hint="ISO code, for geo rules.">
              <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="AU" />
            </Field>
            <Field label="Referer" hint="For hotlink protection.">
              <Input value={referer} onChange={(e) => setReferer(e.target.value)} placeholder="https://example.com/page" />
            </Field>
            <div className="space-y-2 pt-6 text-[13px]">
              <label className="flex items-center gap-2">
                <Checkbox checked={authenticated} onCheckedChange={(c) => setAuthenticated(c === true)} /> Visitor has an API key / staff session
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={live} onCheckedChange={(c) => setLive(c === true)} /> Also fetch it live through the edge
              </label>
            </div>
          </div>
        </form>
      </Panel>

      {!result ? (
        <Panel>
          <EmptyState icon={ScanSearch} title="Inspect a URL" description="Works with /files, /p, /img, /media, /s and custom-domain URLs." />
        </Panel>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <Badge tone={VERDICT[result.verdict].tone} className="px-2 py-1 text-sm">
              {VERDICT[result.verdict].label}
            </Badge>
            <code className="min-w-0 truncate text-xs text-muted-foreground">{result.url}</code>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
            <Section title="Request path">
              <ol className="relative space-y-0 border-l pl-5">
                {result.steps.map((s, i) => (
                  <li key={i} className="relative pb-4 last:pb-0">
                    <span className="absolute -left-[27px] top-0.5 rounded-full bg-background p-0.5">
                      <StepIcon status={s.status} />
                    </span>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{STAGE_LABEL[s.stage] ?? s.stage}</div>
                    <div className="text-[13px] font-medium">{s.title}</div>
                    {s.detail && <div className="text-[13px] text-muted-foreground">{s.detail}</div>}
                    {s.data && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
                        <pre className="mt-1 overflow-x-auto rounded bg-subtle p-2 text-[11px]">{JSON.stringify(s.data, null, 2)}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
            <div className="space-y-4">
              {Object.keys(result.headers).length > 0 && <Headers title="Predicted response headers" headers={result.headers} />}
              {result.live && (
                <Panel className="space-y-2 p-3 text-[13px]">
                  <div className="text-xs font-medium text-muted-foreground">Live request</div>
                  {result.live.error ? (
                    <p className="text-destructive">{result.live.error}</p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      <span>
                        HTTP <strong className="tabular">{result.live.status}</strong>
                      </span>
                      <span>
                        TTFB <strong className="tabular">{result.live.ttfb_ms} ms</strong>
                      </span>
                      <span>
                        Total <strong className="tabular">{result.live.total_ms} ms</strong>
                      </span>
                      {result.live.edge_cache && <Badge tone={result.live.edge_cache === 'HIT' ? 'success' : 'neutral'}>Edge {result.live.edge_cache}</Badge>}
                    </div>
                  )}
                </Panel>
              )}
              {result.live?.headers && <Headers title="Live response headers" headers={result.live.headers} />}
            </div>
          </div>
        </>
      )}
    </>
  );
}
