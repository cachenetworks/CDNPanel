import fs from 'node:fs/promises';
import path from 'node:path';
import { disconnectPrisma, getPrisma, seedDatabase } from '@cdn/database';
import { env } from './config/env.js';
import { baseLogger } from './lib/logger.js';
import { buildApp } from './app.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { stopRequestLog } from './lib/requestLog.js';
import { flushApiKeyUsage, stopApiKeyUsageTimer } from './http/authenticate.js';
import { ensureDefaultProvider } from './lib/storageRegistry.js';

async function main() {
  let e;
  try {
    e = env();
  } catch (err) {
    // Refuse to boot with missing/weak security-critical configuration.
    baseLogger.fatal((err as Error).message);
    process.exit(1);
  }
  await fs.mkdir(path.resolve(e.UPLOAD_TMP_PATH), { recursive: true });
  // Idempotent: keeps permission catalogue and built-in roles in sync with the code.
  await seedDatabase(getPrisma());
  await ensureDefaultProvider();

  const app = await buildApp();
  await app.listen({ host: e.HOST, port: e.PORT });
  baseLogger.info({ port: e.PORT, cdn_url: e.CDN_URL, api_url: e.API_URL }, 'CDN API listening');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    baseLogger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 25_000);
    try {
      await app.close();
      stopApiKeyUsageTimer();
      await flushApiKeyUsage();
      await stopRequestLog();
      await closeQueues();
      await closeRedis();
      await disconnectPrisma();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  baseLogger.fatal({ err }, 'failed to start');
  process.exit(1);
});
