# Redis

Apps with more than one instance need state that every instance sees. Postgres covers this with `store: "database"`; Redis is the other choice, for apps that already run it or want counters off the database. Inferlo has no dependency on a Redis package: you create and connect the client, and Inferlo uses it.

```ts
// src/app.ts
import { createClient } from "redis";
import { createApp } from "@browserlessapi/inferlo";
import { settings } from "./settings.ts";

const redis = await createClient({ url: settings.REDIS_URL }).connect();

export const app = createApp({
  // ...
  redis,
  rateLimit: { store: "redis" },   // route rateLimit counts, shared by every instance
  health: true,                    // GET /ready also checks that Redis answers
});
```

- `redis` is a connected client from the official [`redis`](https://www.npmjs.com/package/redis) package (node-redis 5 or newer). Inferlo talks to it through `client.sendCommand([...])` only, with one key per command. Anything without `sendCommand` raises IL6031. A single Redis server (or a managed endpoint such as Azure Cache, ElastiCache or Upstash with a Redis URL) is supported; Redis Cluster clients (`createCluster`) are not yet.
- ioredis has no `sendCommand` with this shape; wrap it: `redis: { sendCommand: (args) => ioredis.call(args[0]!, ...args.slice(1)) }`.
- Inferlo never connects, reconnects or closes the client. Close it after the app: `await app.close(); await redis.close();`.
- Keys start with `inferlo:<app name>:` (the `name` from `createApp`), so apps that share one Redis keep their keys apart. Give each app its own `name`.

## Rate limits

`createApp({ redis, rateLimit: { store: "redis" } })` keeps the counts of every route's `rateLimit` (see [Rate limiting](routes.md#rate-limiting)) in Redis, one key per route, client and window. Each hit is one atomic Lua script (`INCR`, then `PEXPIRE` on the first hit of a window), so concurrent requests on different instances never over- or under-count, and Redis removes a window's key when it ends. `store: "redis"` without `createApp({ redis })` raises IL6031.

## Cache

`createApp({ redis, cache: { store: "redis" } })` keeps `ctx.cache`, `app.cache` and cached route responses (see [Caching](caching.md)) in Redis:

- Each entry is one key (`inferlo:<app name>:cache:entry:<key>`) with the entry's `ttlMs` as its Redis expiry, so Redis removes expired entries itself.
- Each tag is a Redis set of the entries stored with it. `cache.invalidate(tag)` deletes those entries and the set in one atomic script, on every instance at once. A tag set expires with its longest-lived entry.
- `cache.clear()` walks the app's cache keys with `SCAN` (it does not block Redis like `KEYS`) and deletes them, leaving other apps' keys alone.
- `getOrSet` shares one `compute()` per key within a process, as with the other stores. Instances that miss at the same moment each compute once.

`cache: { store: "redis" }` without `createApp({ redis })` raises IL6031, and `maxEntries` (memory only) raises IL6028.

## Readiness

With `createApp({ redis, health: true })`, `GET /ready` has a built-in `redis` check that sends `PING`, next to `database` and `ai` (see [Health and readiness](deploy.md#health-and-readiness)). A down or slow Redis makes the instance not ready instead of failing requests. Your own check cannot also be called `redis` (IL6014).

## Supported versions

CI runs the Redis tests (rate limits, cache and readiness) against Redis 6.2 (the oldest version still supported upstream, until April 2027), 7.2 and the latest release, and against the `redis` package 5.0.0 and its latest release. Locally, set `INFERLO_TEST_REDIS_URL=redis://localhost:6379` to run them.

The Redis job queue (`jobQueue: { store: "redis" }`) is next on the [roadmap](../ROADMAP.md).
