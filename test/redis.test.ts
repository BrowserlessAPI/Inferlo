import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createClient } from "redis";
import { createApp, InferloError, route, type RedisClient } from "../src/index.ts";
import { redisRateLimitStore } from "../src/redis.ts";

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };

/** A stand-in that records commands and answers like Redis. */
function fakeRedis(answer: (args: string[]) => unknown = (args) => (args[0] === "PING" ? "PONG" : [1, 60_000])) {
  const calls: string[][] = [];
  const client: RedisClient = {
    async sendCommand(args) {
      calls.push(args);
      return answer(args);
    },
  };
  return { client, calls };
}

const limited = route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true }));

describe("createApp({ redis })", () => {
  test("store \"redis\" needs a client, and the client needs sendCommand (IL6031)", () => {
    const code = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL6031" && /createClient/.test(e.fix ?? ""));
    code(() => createApp({ rateLimit: { store: "redis" } }));
    code(() => createApp({ redis: {} as never }));
    code(() => createApp({ redis: "redis://localhost:6379" as never, rateLimit: { store: "redis" } }));
  });

  test('cache store "redis" needs createApp({ redis }) (IL6031), and maxEntries is only for memory (IL6028)', () => {
    assert.throws(() => createApp({ cache: { store: "redis" } }), (e: unknown) => e instanceof InferloError && e.code === "IL6031" && /cache store "redis"/.test(e.message));
    const { client } = fakeRedis();
    assert.throws(() => createApp({ redis: client, cache: { store: "redis", maxEntries: 5 } }), (e: unknown) => e instanceof InferloError && e.code === "IL6028");
    assert.equal(createApp({ redis: client, cache: { store: "redis" } }).cache.store, "redis");
  });

  test("rate limit hits are one EVAL per request, on a key with the app name, the route and the client", async () => {
    const { client, calls } = fakeRedis();
    const app = createApp({ name: "billing", routes: [{ limited }], redis: client, rateLimit: { store: "redis" }, trustProxy: true, logger: quiet });
    const res = await app.request("/limited", { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ratelimit-remaining"), "0");
    assert.equal(res.headers.get("ratelimit-reset"), "60");
    assert.equal(calls.length, 1);
    const [command, script, keys, key, windowMs] = calls[0]!;
    assert.equal(command, "EVAL");
    assert.match(script!, /INCR/);
    assert.equal(keys, "1");
    assert.equal(key, "inferlo:billing:ratelimit:GET /limited ip:203.0.113.9");
    assert.equal(windowMs, "60000");
  });

  test("a client error fails the request with a 500, without the Redis error in the answer", async () => {
    const { client } = fakeRedis(() => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:6379");
    });
    const app = createApp({ routes: [{ limited }], redis: client, rateLimit: { store: "redis" }, logger: quiet });
    const res = await app.request("/limited");
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /ECONNREFUSED|10\.1\.2\.3/);
  });

  test("/ready has a built-in redis check that sends PING", async () => {
    let up = true;
    const { client, calls } = fakeRedis((args) => {
      if (!up) throw new Error("Socket closed unexpectedly");
      return args[0] === "PING" ? "PONG" : [1, 1000];
    });
    const app = createApp({ redis: client, health: true, logger: quiet });
    const ok = await app.request("/ready");
    assert.equal(ok.status, 200);
    const report = (await ok.json()) as { checks: Record<string, { status: string }> };
    assert.equal(report.checks.redis?.status, "ok");
    assert.deepEqual(calls.at(-1), ["PING"]);
    up = false;
    const down = await app.request("/ready");
    assert.equal(down.status, 503);
    const failed = (await down.json()) as { checks: Record<string, { status: string; error?: string }> };
    assert.equal(failed.checks.redis?.status, "error");
    assert.equal(failed.checks.redis?.error, "Check failed.", "the Redis error is logged, not shown");
    // Without createApp({ redis }) there is no redis check, and the name is free for your own.
    const own = createApp({ health: { checks: { redis: () => {} } }, logger: quiet });
    assert.equal((await own.request("/ready")).status, 200);
    assert.throws(() => createApp({ redis: client, health: { checks: { redis: () => {} } } }), (e: unknown) => e instanceof InferloError && e.code === "IL6014");
  });
});

// Runs against a real Redis when INFERLO_TEST_REDIS_URL is set (describe.skip, because Bun 1.3.0 ignores { skip } on describe).
(REDIS_URL ? describe : describe.skip)("Redis rate limit store", () => {
  const connected = REDIS_URL ? createClient({ url: REDIS_URL }).connect() : undefined;
  const client: RedisClient = { sendCommand: async (args) => (await connected!).sendCommand(args) };
  const run = `${Date.now()}-${Math.random()}`;
  after(async () => {
    await (await connected)?.close();
  });

  test("counts hits in fixed windows that Redis expires", async () => {
    const store = redisRateLimitStore(client, `inferlo:test-${run}:`);
    const first = await store.hit("k", 300);
    assert.equal(first.count, 1);
    assert.ok(first.resetMs > 0 && first.resetMs <= 300, `resetMs ${first.resetMs}`);
    assert.equal((await store.hit("k", 300)).count, 2);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal((await store.hit("k", 300)).count, 1, "a new window after the old key expired");
    assert.equal(await (await connected!).exists(`inferlo:test-${run}:ratelimit:k`), 1);
  });

  test("concurrent hits from two app instances share one count", async () => {
    const make = () => createApp({ name: `shared-${run}`, routes: [{ limited: route.get("/limited", { auth: "public", rateLimit: { max: 5, per: "minute", by: "ip" } }).handle(() => ({ ok: true })) }], redis: client, rateLimit: { store: "redis" }, trustProxy: true, logger: quiet });
    const [a, b] = [make(), make()];
    const headers = { "x-forwarded-for": "198.51.100.20" };
    const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).request("/limited", { headers }).then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 200).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 5);
  });

  test("a key that lost its expiry gets one again", async () => {
    const redis = await connected!;
    const key = `inferlo:test-${run}:ratelimit:stuck`;
    await redis.set(key, "7");
    const hit = await redisRateLimitStore(client, `inferlo:test-${run}:`).hit("stuck", 60_000);
    assert.equal(hit.count, 8);
    assert.ok(hit.resetMs > 0 && hit.resetMs <= 60_000);
    assert.ok((await redis.pTTL(key)) > 0);
  });

  test("the real client passes the readiness check", async () => {
    const app = createApp({ redis: await connected!, health: true, logger: quiet });
    const report = (await (await app.request("/ready")).json()) as { checks: Record<string, { status: string }> };
    assert.equal(report.checks.redis?.status, "ok");
  });
});
