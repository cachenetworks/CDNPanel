/**
 * Runtime core of the CDNPanel TypeScript SDK (works in Node 18+, browsers, Deno and Bun).
 * Endpoint methods are generated into generated.ts from the OpenAPI document.
 */

export interface CdnClientOptions {
  /** Base URL of the deployment, e.g. https://cdn.example.com */
  baseUrl: string;
  /** API key (cdn_live_… / cdn_test_…). */
  apiKey: string;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Retries for 429 / 5xx / network errors on idempotent requests (default 2). */
  retries?: number;
  userAgent?: string;
}

export interface RequestOptions {
  method: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  form?: FormData;
  raw?: Uint8Array | Blob;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw Response instead of parsed JSON (downloads). */
  responseType?: 'json' | 'response';
}

export class CdnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CdnApiError';
  }
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CdnCore {
  protected readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly userAgent?: string;

  constructor(opts: CdnClientOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    if (!opts.apiKey) throw new Error('apiKey is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = opts.retries ?? 2;
    this.userAgent = opts.userAgent;
  }

  /** Low-level request; prefer the generated endpoint methods. */
  async request<T>(path: string, opts: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(opts.headers ?? {}) };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.raw) {
      headers['Content-Type'] = 'application/octet-stream';
      body = opts.raw as BodyInit;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const attempts = IDEMPOTENT.has(opts.method) ? this.retries + 1 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, { method: opts.method, headers, body, signal: opts.signal });
        if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
          continue;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } } | null;
          const e = data?.error;
          throw new CdnApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed with HTTP ${res.status}`, e?.request_id, e?.details);
        }
        if (opts.responseType === 'response') return res as unknown as T;
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (err) {
        if (err instanceof CdnApiError || (err as Error).name === 'AbortError' || attempt >= attempts) throw err;
        lastErr = err;
        await sleep(250 * 2 ** attempt);
      }
    }
    throw lastErr;
  }
}
