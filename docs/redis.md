# Redis

Apps with more than one instance need state that every instance sees. Postgres covers this with `store: "database"`; Redis is the other choice, for apps that already run it or want counters off the database. Inferlo has no dependency on a Redis package: you create and connect the client, and Inferlo uses it.

```ts
// src/app.ts
import { createClient } from "redis";
import { createApp } from "@browserlessapi/inferlo";
import { settings } from "./settings.ts";

const redis = await createClient({ url: settings.REDIS_URL }).connect();

export const app = createApp({
  name: "boards",
  // ...
  redis,
  rateLimit: { store: "redis" },   // route rateLimit counts, shared by every instance
  cache: { store: "redis" },       // ctx.cache, app.cache and cached routes
  jobQueue: { store: "redis" },    // background jobs and cron ticks
  events: { transport: "redis" },  // events to and from other services (Redis Streams)
  // WebSocket broadcasts to every instance (Redis Pub/Sub, on a second connection)
  sockets: { transport: "redis", subscriber: await redis.duplicate().connect() },
  health: true,                    // GET /ready also checks that Redis answers
});
```

- `redis` is a connected client from the official [`redis`](https://www.npmjs.com/package/redis) package (node-redis 5 or newer). Inferlo talks to it through `client.sendCommand([...])` only, with one key per command. Anything without `sendCommand` raises IL6031. A single Redis server (or a managed endpoint such as Azure Cache, ElastiCache or Upstash with a Redis URL) is supported; Redis Cluster clients (`createCluster`) are not yet.
- Apps that already use [ioredis](https://github.com/redis/ioredis) (BullMQ's client) pass their connection through `ioredisClient` instead; see [ioredis](#ioredis).
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

## Job queue

`createApp({ redis, jobQueue: { store: "redis" } })` keeps background jobs (see [Background jobs](jobs.md)) in Redis, shared by every instance and by `inferlo worker`:

- Each job is a hash (`inferlo:<app name>:jobs:job:<id>`). Pending jobs are in one sorted set per job name (`jobs:due:<name>`), scored by `runAt`, and running jobs in `jobs:running`, scored by the last report from their worker.
- Claiming, finishing, retrying and reporting are each one atomic Lua script, so a due job is claimed by exactly one instance however many run `app.jobs.start()` or `inferlo worker`. An instance only claims the jobs it has registered.
- A running job whose worker has not reported for 5 minutes (it crashed or lost Redis) is claimed again with `lastError` saying the worker stopped, or marked `"failed"` without attempts left. The time comes from the Redis server (`TIME`), so instances with different clocks agree.
- Pending and running jobs never expire. Finished jobs are kept for 7 days for `app.jobs.get(id)`, then Redis removes them.
- Cron ticks use fixed job ids, so every instance can run the schedule and each tick is queued once.

Use a Redis that keeps its data (AOF or RDB persistence, or a managed Redis with persistence), or queued jobs are lost when Redis restarts. `jobQueue: { store: "redis" }` without `createApp({ redis })` raises IL6031.

## Events

`createApp({ name, redis, events: { transport: "redis" } })` sends published events to other services through Redis Streams (see [Events between services](jobs.md#between-services)):

- Each event name has one stream, `inferlo:events:<event name>`, shared by every app on the Redis (without the app prefix, so services find each other's events). `events.publish` adds one entry (`XADD`) with the fields `id`, `payload` (JSON), `publishedAt` and, with tracing, `traceparent` and `tracestate`.
- Each service reads with a consumer group named after its `createApp({ name })`, created at the end of the stream the first time the service receives. Each instance is one consumer in the group (`XREADGROUP`, without blocking, on every worker poll), so the instances of a service share its events.
- An entry is acknowledged (`XACK`) after its jobs are queued. An entry read but not acknowledged for 30 seconds is claimed by another instance (`XAUTOCLAIM`), so the events of a crashed instance are not lost. Consumers of stopped instances (nothing pending, idle for an hour) are removed from the group.
- Streams are trimmed to about 100,000 entries each (`XADD ... MAXLEN ~`), so a subscriber that is down for a very long time can miss the oldest events.
- A deleted stream or group (`FLUSHDB`) is created again on the next poll.

As for the job queue, use a Redis that keeps its data, or events not yet received are lost when Redis restarts.

## WebSocket broadcasts

`createApp({ name, redis, sockets: { transport: "redis", subscriber } })` sends every `sockets.broadcast(room, data)` to the sockets of every instance (see [Rooms and broadcast](websockets.md#rooms-and-broadcast)):

- A broadcast goes to the sockets of the instance that sends it, then is published (`PUBLISH`) on one channel per app, `inferlo:<app name>:sockets`, with the room and its tenant. Each instance with open sockets subscribes to the channel and sends what the others published to its own sockets in that room; an instance does not get its own broadcasts back. Apps with other names on the same Redis never see each other's broadcasts.
- `subscriber` is a second connected client, `await redis.duplicate().connect()`: a client that subscribes cannot send other commands, so it cannot be the `redis` client (IL6036 otherwise, and for a missing `name` or subscriber). With ioredis, pass `ioredisSubscriber(connection.duplicate())` (see [ioredis](#ioredis)). Close it after the app, like the `redis` client.
- An instance subscribes when its first WebSocket connection opens, so `inferlo worker` and other processes without sockets only publish. `app.close()` unsubscribes.
- Pub/Sub keeps nothing: an instance that is not connected to Redis while a broadcast is published does not get it. Clients that reconnect should load the current state over HTTP, then apply the broadcasts that follow.

## ioredis

Apps that already have an [ioredis](https://github.com/redis/ioredis) connection (BullMQ, and many Express and NestJS apps, use it) give it to Inferlo with `ioredisClient` and `ioredisSubscriber` from `@browserlessapi/inferlo/ioredis`. Every Redis feature above works the same:

```ts
import Redis from "ioredis";
import { createApp } from "@browserlessapi/inferlo";
import { ioredisClient, ioredisSubscriber } from "@browserlessapi/inferlo/ioredis";

const connection = new Redis(settings.REDIS_URL);

export const app = createApp({
  name: "boards",
  redis: ioredisClient(connection),
  rateLimit: { store: "redis" },
  cache: { store: "redis" },
  jobQueue: { store: "redis" },
  events: { transport: "redis" },
  sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) },
  health: true,
});
```

- `ioredisClient(connection)` sends Inferlo's commands with ioredis's `connection.call(command, ...args)` (ioredis 5 and later), so the connection's reconnects, TLS and Sentinel settings apply. Inferlo never connects or closes it: `await app.close(); connection.disconnect();`.
- `ioredisSubscriber(second)` receives WebSocket broadcasts on a second connection (`connection.duplicate()`), because a subscribed connection cannot send other commands. One connection given to both raises IL6064.
- A connection with ioredis's `keyPrefix` raises IL6064: Inferlo already prefixes its keys with `inferlo:<app name>:`, and ioredis does not prefix the `SCAN` patterns `cache.clear()` uses. Pass `connection.duplicate({ keyPrefix: "" })`.
- An ioredis connection passed as `redis` or `sockets.subscriber` without the wrappers raises IL6065, because ioredis's own `sendCommand` and `subscribe` take other arguments. Anything else that is not an ioredis connection raises IL6064.
- ioredis is not a dependency of Inferlo. Tested with ioredis 5.3.0 and the latest release, on Redis 6.2 and the latest Redis, with BullMQ's queues on the same server.

## Readiness

With `createApp({ redis, health: true })`, `GET /ready` has a built-in `redis` check that sends `PING`, next to `database` and `ai` (see [Health and readiness](deploy.md#health-and-readiness)). A down or slow Redis makes the instance not ready instead of failing requests. Your own check cannot also be called `redis` (IL6014).

## Supported versions

CI runs the Redis tests (rate limits, cache, job queue with cron ticks, events transport, and readiness) against Redis 6.2 (the oldest version still supported upstream, until April 2027), 7.2 and the latest release, and against the `redis` package 5.0.0 and its latest release. The ioredis job runs the same features through `ioredisClient` on ioredis 5.3.0 and its latest release. Locally, set `INFERLO_TEST_REDIS_URL=redis://localhost:6379` to run them.
