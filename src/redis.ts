/**
 * Redis for state shared by every instance: createApp({ redis: client, rateLimit: { store: "redis" }, cache: { store: "redis" } }).
 * Inferlo does not depend on a Redis package. It talks to the client you create and connect (the official
 * `redis` package, node-redis 5 or newer) through its sendCommand method, and never closes it.
 */
import { InferloError } from "./errors.ts";
import type { CacheStore } from "./cache.ts";
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

// Stores an entry with its time to live and adds it to each tag's set. A tag set lives as long as its
// longest-lived entry, so sets of expired entries are removed by Redis too.
const SET_ENTRY = `redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
local ttl = tonumber(ARGV[2])
for i = 2, #KEYS do
  redis.call("SADD", KEYS[i], KEYS[1])
  if redis.call("PTTL", KEYS[i]) < ttl then redis.call("PEXPIRE", KEYS[i], ttl) end
end
return 1`;

// Removes every entry in the given tag sets, then the sets.
const INVALIDATE = `for i = 1, #KEYS do
  local members = redis.call("SMEMBERS", KEYS[i])
  for j = 1, #members, 500 do
    redis.call("DEL", unpack(members, j, math.min(j + 499, #members)))
  end
  redis.call("DEL", KEYS[i])
end
return 1`;

/**
 * Cache entries in Redis, shared by every instance: one key per entry, expired by Redis, and one set per tag
 * with the keys stored under it, so cache.invalidate(tag) reaches every instance.
 */
export function redisCacheStore(client: RedisClient, prefix: string): CacheStore {
  const entry = (key: string) => `${prefix}cache:entry:${key}`;
  const tag = (name: string) => `${prefix}cache:tag:${name}`;
  return {
    async get(key) {
      const value = await client.sendCommand(["GET", entry(key)]);
      return value === null || value === undefined ? undefined : String(value);
    },
    async set(key, json, ttlMs, tags) {
      const keys = [entry(key), ...tags.map(tag)];
      await client.sendCommand(["EVAL", SET_ENTRY, String(keys.length), ...keys, json, String(ttlMs)]);
    },
    async delete(key) {
      await client.sendCommand(["DEL", entry(key)]);
    },
    async invalidate(tags) {
      if (!tags.length) return;
      await client.sendCommand(["EVAL", INVALIDATE, String(tags.length), ...tags.map(tag)]);
    },
    async clear() {
      // SCAN walks the keys without blocking Redis; only this app's cache keys match the pattern.
      const pattern = `${escapeGlob(prefix)}cache:*`;
      let cursor = "0";
      do {
        const [next, keys] = (await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "500"])) as [string | Uint8Array, (string | Uint8Array)[]];
        cursor = String(next);
        if (keys.length) await client.sendCommand(["DEL", ...keys.map(String)]);
      } while (cursor !== "0");
    },
  };
}

/** Escapes the characters SCAN MATCH treats as a pattern, so an app name like "a*b" matches only itself. */
function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, "\\$&");
}
