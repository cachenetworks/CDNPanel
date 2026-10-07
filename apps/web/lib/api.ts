/**
 * Dashboard API client. All requests go to the same origin (`/api/v1/...`) with the
 * HttpOnly session cookie. The CSRF token is kept in memory only (never in storage)
 * and sent on state-changing requests.
 */

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthError(fn: Listener) {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Do not trigger the global "signed out" handler on 401. */
  silent?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(buildUrl(`/api/v1${path}`, opts.query), {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } } | null)?.error;
    const err = new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status})`, e?.request_id, e?.details);
    if (res.status === 401 && !opts.silent && (err.code === 'unauthenticated' || err.code === 'session_expired')) authListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; total_pages: number; has_more: boolean };
}

/** XHR-based request with upload progress (fetch has no upload progress events). */
export function xhrUpload<T>(
  url: string,
  body: XMLHttpRequestBodyInit,
  opts: { method?: string; headers?: Record<string, string>; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method ?? 'POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const e = (data as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
        reject(new ApiError(xhr.status, e?.code ?? 'http_error', e?.message ?? `Upload failed (${xhr.status})`, e?.request_id));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network error — the connection was interrupted.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    opts.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
