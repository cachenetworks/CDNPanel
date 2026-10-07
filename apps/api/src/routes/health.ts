import { getPrisma } from '@cdn/database';
import { defineRoute, type RouteDef } from '../http/route.js';
import { getRedis } from '../lib/redis.js';
import { driverFor, ensureDefaultProvider } from '../lib/storageRegistry.js';

const startedAt = Date.now();

async function timed(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<'ok' | 'error'> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return 'ok';
  } catch {
    return 'error';
  }
}

export const healthRoutes: RouteDef<any, any, any>[] = [
  defineRoute({
    method: 'GET',
    url: '/health',
    tag: 'Health',
    summary: 'Liveness',
    description: 'Returns 200 while the process is running.',
    auth: 'public',
    responses: { 200: { description: 'Alive', example: { status: 'ok', uptime_seconds: 3600 } } },
    async handler() {
      return { status: 'ok', uptime_seconds: Math.round((Date.now() - startedAt) / 1000) };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/health/ready',
    tag: 'Health',
    summary: 'Readiness',
    description: 'Checks PostgreSQL, Redis and the default storage backend. Returns 503 if any dependency is unavailable. No diagnostic details are exposed.',
    auth: 'public',
    responses: {
      200: { description: 'Ready', example: { status: 'ready', checks: { database: 'ok', redis: 'ok', storage: 'ok' } } },
      503: { description: 'Not ready', example: { status: 'not_ready', checks: { database: 'ok', redis: 'error', storage: 'ok' } } },
    },
    async handler({ reply }) {
      const [database, redis, storage] = await Promise.all([
        timed(() => getPrisma().$queryRaw`SELECT 1`),
        timed(() => getRedis().ping()),
        timed(async () => driverFor(await ensureDefaultProvider()).healthCheck()),
      ]);
      const checks = { database, redis, storage };
      const ok = Object.values(checks).every((c) => c === 'ok');
      reply.code(ok ? 200 : 503);
      return { status: ok ? 'ready' : 'not_ready', checks };
    },
  }),
];
