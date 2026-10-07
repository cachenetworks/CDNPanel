import type { Redis } from 'ioredis';

/**
 * Redis-backed fixed-window rate limiter. Atomic via a Lua script so concurrent API
 * instances share the same counters.
 */
const SCRIPT = `
local current = redis.call('INCRBY', KEYS[1], ARGV[2])
if current == tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  reset: number;
  retryAfter: number;
}

export class RateLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = 'rl') {}

  async hit(bucket: string, limit: number, windowSeconds: number, cost = 1): Promise<RateLimitResult> {
    const key = `${this.prefix}:${bucket}`;
    const res = (await this.redis.eval(SCRIPT, 1, key, String(windowSeconds * 1000), String(cost))) as [number, number];
    const count = Number(res[0]);
    const ttl = Number(res[1]);
    const reset = Math.ceil((Date.now() + ttl) / 1000);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
      retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }

  /** Read without incrementing. */
  async peek(bucket: string): Promise<number> {
    const v = await this.redis.get(`${this.prefix}:${bucket}`);
    return v ? Number(v) : 0;
  }

  async reset(bucket: string): Promise<void> {
    await this.redis.del(`${this.prefix}:${bucket}`);
  }
}
