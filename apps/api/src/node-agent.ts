/**
 * CDNPanel storage node agent.
 *
 * Runs on every extra server that lends its disk to the CDN. It is a deliberately small blob server:
 * the main CDN server decides what to store (shards of RAID pools) and talks to it over HTTP(S) with a
 * shared bearer token. It never talks to the database or Redis.
 *
 *   NODE_TOKEN       required, ≥ 32 characters (generate: openssl rand -base64 48)
 *   NODE_DATA_PATH   where objects are stored (default /data/node)
 *   NODE_NAME        label shown in the panel (default: hostname)
 *   PORT / HOST      listen address (default 0.0.0.0:8874)
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LocalStorageDriver, StorageError, StorageKeyError, assertSafeKey } from '@cdn/storage';

export const NODE_AGENT_VERSION = '1';

export interface NodeAgentOptions {
  token: string;
  dataPath: string;
  name?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

function digest(v: string): Buffer {
  return createHash('sha256').update(v).digest();
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export function createNodeAgent(opts: NodeAgentOptions): http.Server {
  if (!opts.token || opts.token.length < 32) throw new Error('NODE_TOKEN must be at least 32 characters');
  const expected = digest(opts.token);
  const store = new LocalStorageDriver({ root: opts.dataPath });
  const started = Date.now();
  const name = opts.name || os.hostname();
  const log = opts.log ?? (() => undefined);

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    if (res.headersSent) return res.destroy();
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json);
  };

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const parts: Buffer[] = [];
    let len = 0;
    for await (const c of req) {
      len += (c as Buffer).length;
      if (len > 64 * 1024) throw new StorageError('body too large');
      parts.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as Record<string, unknown>;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://node');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });

      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!presented || !timingSafeEqual(digest(presented), expected)) {
        req.resume();
        return send(res, 401, { error: 'unauthorized' });
      }

      if (url.pathname === '/v1/status' && req.method === 'GET') {
        const cap = await store.capacity();
        return send(res, 200, { version: NODE_AGENT_VERSION, node_name: name, total: cap.total, available: cap.available, objects_path: opts.dataPath, uptime_seconds: Math.round((Date.now() - started) / 1000) });
      }
      if (url.pathname === '/v1/health' && req.method === 'POST') {
        await store.healthCheck();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/v1/list' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        if (prefix) assertSafeKey(prefix.replace(/\/$/, '') || 'x');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        for await (const key of store.listKeys(prefix)) {
          if (!res.write(`${key}\n`)) await new Promise((r) => res.once('drain', r));
        }
        return res.end();
      }
      if (url.pathname === '/v1/copy' && req.method === 'POST') {
        const body = await readJson(req);
        const from = String(body.from ?? '');
        const to = String(body.to ?? '');
        assertSafeKey(from);
        assertSafeKey(to);
        if (!(await store.head(from))) return send(res, 404, { error: 'not_found' });
        await store.copy(from, to);
        return send(res, 200, { ok: true });
      }

      if (url.pathname.startsWith('/v1/objects/')) {
        const key = url.pathname.slice('/v1/objects/'.length).split('/').map(decodeURIComponent).join('/');
        assertSafeKey(key);
        switch (req.method) {
          case 'PUT': {
            await store.put(key, req, { contentType: String(req.headers['x-object-type'] ?? 'application/octet-stream') });
            return send(res, 201, { ok: true });
          }
          case 'GET':
          case 'HEAD': {
            const info = await store.head(key);
            if (!info) return send(res, 404, req.method === 'HEAD' ? undefined : { error: 'not_found' });
            const range = parseRange(req.headers.range, info.size);
            if (range === 'invalid') return send(res, 416, { error: 'range_not_satisfiable' });
            const headers: Record<string, string> = {
              'content-type': 'application/octet-stream',
              'accept-ranges': 'bytes',
              'content-length': String(range ? range.end - range.start + 1 : info.size),
            };
            if (info.lastModified) headers['last-modified'] = info.lastModified.toUTCString();
            if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`;
            res.writeHead(range ? 206 : 200, headers);
            if (req.method === 'HEAD' || info.size === 0) return res.end();
            await pipeline(await store.get(key, range ?? undefined), res);
            return;
          }
          case 'DELETE':
            await store.delete(key);
            return send(res, 204);
        }
      }
      req.resume();
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof StorageKeyError) return send(res, 400, { error: 'invalid_key' });
      if (err instanceof StorageError && /not found/i.test(err.message)) return send(res, 404, { error: 'not_found' });
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return res.destroy();
      log('request failed', { err: (err as Error).message, method: req.method, url: req.url });
      return send(res, 500, { error: 'internal_error', message: (err as Error).message.slice(0, 200) });
    }
  });
}

/* c8 ignore start — process entry point */
if (process.argv[1] && path.basename(process.argv[1]).startsWith('node-agent')) {
  const token = process.env.NODE_TOKEN ?? '';
  const dataPath = path.resolve(process.env.NODE_DATA_PATH ?? '/data/node');
  const port = Number(process.env.PORT ?? 8874);
  const host = process.env.HOST ?? '0.0.0.0';
  const logLine = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
    process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), service: 'cdn-node', msg, ...extra })}\n`);
  let server: http.Server;
  try {
    server = createNodeAgent({ token, dataPath, name: process.env.NODE_NAME, log: (m, e) => logLine('warn', m, e) });
  } catch (err) {
    logLine('fatal', (err as Error).message);
    process.exit(1);
  }
  // Long transfers: no request timeout, but drop idle sockets.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  server.listen(port, host, () => logLine('info', 'storage node listening', { port, host, data_path: dataPath, version: NODE_AGENT_VERSION }));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
/* c8 ignore stop */
