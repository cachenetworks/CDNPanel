import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { assertSafeKey } from './keys.js';
import { StorageError, type ByteRange, type CapacityInfo, type ObjectInfo, type PutOptions, type StorageDriver } from './types.js';

export interface NodeStorageConfig {
  /** Base URL of the node agent, e.g. https://node-2.example.com:8874 */
  url: string;
  /** Shared secret configured on the agent (NODE_TOKEN). */
  token: string;
  /** Per-request timeout for metadata calls (ms). Transfers are not time-limited. */
  timeoutMs?: number;
}

export interface NodeStatus {
  version: string;
  node_name: string;
  total: number | null;
  available: number | null;
  objects_path: string;
  uptime_seconds: number;
}

/** Talks to a CDNPanel storage node agent (`node dist/node-agent.js`) over HTTP(S). */
export class NodeStorageDriver implements StorageDriver {
  readonly kind = 'NODE' as const;
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: NodeStorageConfig) {
    if (!config.url) throw new StorageError('Node URL is required');
    if (!config.token) throw new StorageError('Node token is required');
    this.base = config.url.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  private objectUrl(key: string): string {
    assertSafeKey(key);
    return `${this.base}/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async call(url: string, init: RequestInit & { duplex?: 'half' } = {}, timed = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: timed ? AbortSignal.timeout(this.timeoutMs) : undefined });
    } catch (err) {
      throw new StorageError(`Node ${this.base} is unreachable: ${(err as Error).message}`, err);
    }
    if (res.status === 401 || res.status === 403) throw new StorageError(`Node ${this.base} rejected the token`);
    return res;
  }

  async status(): Promise<NodeStatus> {
    const res = await this.call(`${this.base}/v1/status`);
    if (!res.ok) throw new StorageError(`Node status failed (${res.status})`);
    return (await res.json()) as NodeStatus;
  }

  async put(key: string, body: Readable | Buffer, opts: PutOptions): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-object-type': opts.contentType };
    if (opts.size !== undefined) headers['content-length'] = String(opts.size);
    const payload = Buffer.isBuffer(body) ? body : (Readable.toWeb(body) as unknown as ReadableStream);
    const res = await this.call(this.objectUrl(key), { method: 'PUT', headers, body: payload as unknown as RequestInit['body'], duplex: 'half' }, false);
    if (!res.ok) throw new StorageError(`Node write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    await res.arrayBuffer();
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    const res = await this.call(this.objectUrl(key), { headers }, false);
    if (res.status === 404) throw new StorageError('Object not found');
    if (!res.ok || !res.body) throw new StorageError(`Node read failed (${res.status})`);
    if (range && res.status !== 206) {
      await res.body.cancel();
      throw new StorageError('Node ignored the byte range');
    }
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.call(this.objectUrl(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`Node head failed (${res.status})`);
    const lm = res.headers.get('last-modified');
    return { size: Number(res.headers.get('content-length') ?? 0), lastModified: lm ? new Date(lm) : undefined };
  }

  async delete(key: string): Promise<void> {
    const res = await this.call(this.objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new StorageError(`Node delete failed (${res.status})`);
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    assertSafeKey(sourceKey);
    assertSafeKey(destKey);
    const res = await this.call(`${this.base}/v1/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: sourceKey, to: destKey }) }, false);
    if (res.status === 404) throw new StorageError('Object not found');
    if (!res.ok) throw new StorageError(`Node copy failed (${res.status})`);
  }

  async healthCheck(): Promise<void> {
    const res = await this.call(`${this.base}/v1/health`, { method: 'POST' });
    if (!res.ok) throw new StorageError(`Node health check failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async capacity(): Promise<CapacityInfo> {
    try {
      const s = await this.status();
      return { total: s.total, available: s.available };
    } catch {
      return { total: null, available: null };
    }
  }

  async *listKeys(prefix = ''): AsyncIterable<string> {
    const res = await this.call(`${this.base}/v1/list?prefix=${encodeURIComponent(prefix)}`, {}, false);
    if (!res.ok || !res.body) throw new StorageError(`Node list failed (${res.status})`);
    // Newline-delimited keys, streamed so very large stores never sit in memory.
    let buf = '';
    const decoder = new TextDecoder();
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (buf) yield buf;
  }
}
