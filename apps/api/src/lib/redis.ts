import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false });
  }
  return client;
}

/** Separate connection options for BullMQ (requires maxRetriesPerRequest: null). */
export function bullConnection(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = undefined;
  }
}
