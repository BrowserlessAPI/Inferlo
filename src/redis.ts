/**
 * Redis for state shared by every instance: createApp({ redis: client, rateLimit: { store: "redis" } }).
 * Inferlo does not depend on a Redis package. It talks to the client you create and connect (the official
 * `redis` package, node-redis 5 or newer) through its sendCommand method, and never closes it.
 */
import { InferloError } from "./errors.ts";
import type { RateLimitStore } from "./rate-limit.ts";

/**
 * A connected Redis client: the client from createClient() of the `redis` package (await client.connect() first).
 * For ioredis, pass { sendCommand: (args) => ioredis.call(args[0], ...args.slice(1)) }.
 */
export interface RedisClient {
  sendCommand(args: string[]): Promise<unknown>;
}

const fix = 'Create and connect a client with the redis package: const redis = await createClient({ url: process.env.REDIS_URL }).connect(); then createApp({ redis, rateLimit: { store: "redis" } }).';

/** Checks createApp({ redis }) at startup. Raises IL6031. */
export function checkRedisClient(client: unknown): RedisClient | undefined {
  if (client === undefined) return undefined;
  if (typeof client !== "object" || client === null || typeof (client as RedisClient).sendCommand !== "function") {
    throw new InferloError("IL6031", "createApp({ redis }) needs a Redis client with a sendCommand method.", { fix });
  }
  return client as RedisClient;
}

/** IL6031 for a store "redis" without createApp({ redis }). */
export function redisMissing(option: string): InferloError {
  return new InferloError("IL6031", `${option} store "redis" needs a Redis client, but createApp has no redis option.`, { fix });
}

/** The key prefix for an app: "inferlo:<app name>:", so apps sharing one Redis keep their keys apart. */
export function redisPrefix(appName: string | undefined): string {
  return `inferlo:${appName ?? "inferlo-app"}:`;
}

/** Readiness: PING answers. */
export async function pingRedis(client: RedisClient): Promise<void> {
  const reply = await client.sendCommand(["PING"]);
  if (String(reply) !== "PONG") throw new Error(`Redis answered PING with ${JSON.stringify(reply)}.`);
}

// One atomic step per hit: count, start the window on the first hit, and report the time left.
// The PTTL check repairs a key that lost its expiry, so a window can never last forever.
const HIT = `local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end
return { count, ttl }`;

/** Rate limit counts in Redis: one key per client and route window, which Redis expires with the window. */
export function redisRateLimitStore(client: RedisClient, prefix: string): RateLimitStore {
  return {
    async hit(key, ms) {
      const reply = (await client.sendCommand(["EVAL", HIT, "1", `${prefix}ratelimit:${key}`, String(ms)])) as [number | string, number | string];
      return { count: Number(reply[0]), resetMs: Math.max(0, Number(reply[1])) };
    },
  };
}
