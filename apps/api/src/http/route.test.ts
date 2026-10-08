import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

process.env.APP_URL ??= 'https://panel.example.com';
process.env.CDN_URL ??= 'https://cdn.example.com';
process.env.API_URL ??= 'https://cdn.example.com';
process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.REDIS_URL ??= 'redis://unused';
process.env.SESSION_SECRET ??= randomBytes(48).toString('base64url');
process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

describe('registerRoutes', () => {
  it('does not send twice when a handler sends and returns the reply (async onSend hooks pending)', async () => {
    const { default: Fastify } = await import('fastify');
    const { defineRoute, registerRoutes } = await import('./route.js');
    const app = Fastify();
    const unhandled: unknown[] = [];
    app.setErrorHandler((err, _req, reply) => {
      unhandled.push(err);
      return reply.send(err);
    });
    // Mirrors the app's security-header hook: async, so `reply.sent` is still false when the handler returns.
    app.addHook('onSend', async (_req, _reply, payload) => {
      await new Promise((r) => setTimeout(r, 5));
      return payload;
    });
    registerRoutes(app, [
      defineRoute({
        method: 'GET',
        url: '/:mode',
        tag: 'Test',
        summary: 'stream',
        description: 'stream',
        auth: 'public',
        responses: { 200: { description: 'bytes' } },
        async handler({ req, reply }) {
          // `empty` mirrors x-accel delivery (headers only, Nginx serves the bytes).
          if ((req.params as { mode: string }).mode === 'empty') return reply.code(200).header('X-Accel-Redirect', '/x').send();
          return reply.code(200).send(Readable.from([Buffer.alloc(64 * 1024, 1)]));
        },
      } as never),
    ]);
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/stream`);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(64 * 1024);
      const empty = await fetch(`http://127.0.0.1:${port}/empty`);
      expect(empty.status).toBe(200);
      expect(empty.headers.get('x-accel-redirect')).toBe('/x');
      await empty.arrayBuffer();
      expect(unhandled).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
