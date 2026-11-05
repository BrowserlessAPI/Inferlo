import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, InferloError, job, memory, route, t, type Adapter, type Cache, type CacheConfig } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { createCache, memoryCacheStore } from "../src/cache.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const quiet = { info: () => {}, error: () => {} };
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

/** The same behaviour for every store. */
function cacheContract(name: string, makeCache: () => Cache) {
  describe(`cache (${name} store)`, () => {
    test("set, get and delete JSON values; missing keys are undefined", async () => {
      const cache = makeCache();
      assert.equal(await cache.get(`missing-${suffix}`), undefined);
      await cache.set(`a-${suffix}`, { n: 1, list: ["x"], at: new Date("2030-01-01T00:00:00Z"), none: null }, { ttlMs: 60_000 });
      assert.deepEqual(await cache.get(`a-${suffix}`), { n: 1, list: ["x"], at: "2030-01-01T00:00:00.000Z", none: null }, "stored as JSON");
      await cache.set(`a-${suffix}`, "replaced", { ttlMs: 60_000 });
      assert.equal(await cache.get<string>(`a-${suffix}`), "replaced");
      await cache.set(`null-${suffix}`, null, { ttlMs: 60_000 });
      assert.equal(await cache.get(`null-${suffix}`), null, "null is a value");
      await cache.delete(`a-${suffix}`);
      assert.equal(await cache.get(`a-${suffix}`), undefined);
    });

    test("entries expire after ttlMs", async () => {
      const cache = makeCache();
      await cache.set(`short-${suffix}`, 1, { ttlMs: 30 });
      assert.equal(await cache.get(`short-${suffix}`), 1);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(await cache.get(`short-${suffix}`), undefined);
    });

    test("getOrSet computes once, stores the result and returns the stored form", async () => {
      const cache = makeCache();
      let calls = 0;
      const compute = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { at: new Date("2030-01-01T00:00:00Z"), calls };
      };
      const [a, b] = await Promise.all([cache.getOrSet(`stats-${suffix}`, { ttlMs: 60_000 }, compute), cache.getOrSet(`stats-${suffix}`, { ttlMs: 60_000 }, compute)]);
      assert.equal(calls, 1, "concurrent calls share one compute()");
      assert.deepEqual(a, { at: "2030-01-01T00:00:00.000Z", calls: 1 });
      assert.deepEqual(b, a);
      assert.deepEqual(await cache.getOrSet(`stats-${suffix}`, { ttlMs: 60_000 }, compute), a);
      assert.equal(calls, 1, "later calls hit the cache");
    });

    test("getOrSet stores nothing when compute() throws", async () => {
      const cache = makeCache();
      await assert.rejects(cache.getOrSet(`fails-${suffix}`, { ttlMs: 60_000 }, () => Promise.reject(new Error("upstream down"))), /upstream down/);
      assert.equal(await cache.get(`fails-${suffix}`), undefined);
      assert.equal(await cache.getOrSet(`fails-${suffix}`, { ttlMs: 60_000 }, () => 5), 5);
    });

    test("invalidate removes every entry with one of the tags", async () => {
      const cache = makeCache();
      const tickets = `tickets-${suffix}`;
      const users = `users-${suffix}`;
      await cache.set(`t1-${suffix}`, 1, { ttlMs: 60_000, tags: [tickets] });
      await cache.set(`t2-${suffix}`, 2, { ttlMs: 60_000, tags: [tickets, users] });
      await cache.set(`u1-${suffix}`, 3, { ttlMs: 60_000, tags: [users] });
      await cache.set(`plain-${suffix}`, 4, { ttlMs: 60_000 });
      await cache.invalidate(tickets);
      assert.equal(await cache.get(`t1-${suffix}`), undefined);
      assert.equal(await cache.get(`t2-${suffix}`), undefined);
      assert.equal(await cache.get(`u1-${suffix}`), 3);
      await cache.invalidate([users, `other-${suffix}`]);
      assert.equal(await cache.get(`u1-${suffix}`), undefined);
      assert.equal(await cache.get(`plain-${suffix}`), 4);
      await cache.invalidate([]);
    });

    test("invalid keys, options and values raise IL6028", async () => {
      const cache = makeCache();
      await assert.rejects(cache.get(""), isCode("IL6028"));
      await assert.rejects(cache.get("x".repeat(513)), isCode("IL6028"));
      await assert.rejects(cache.set("k", 1, {} as never), isCode("IL6028"));
      await assert.rejects(cache.set("k", 1, { ttlMs: 0 }), isCode("IL6028"));
      await assert.rejects(cache.set("k", 1, { ttlMs: 1.5 }), isCode("IL6028"));
      await assert.rejects(cache.set("k", 1, { ttlMs: 366 * 86_400_000 }), isCode("IL6028"));
      await assert.rejects(cache.set("k", 1, { ttlMs: 1000, tags: [""] }), isCode("IL6028"));
      await assert.rejects(cache.set("k", undefined, { ttlMs: 1000 }), isCode("IL6028"));
      await assert.rejects(cache.set("k", 10n, { ttlMs: 1000 }), isCode("IL6028"));
      await assert.rejects(cache.getOrSet("k", { ttlMs: 1000 }, () => undefined), isCode("IL6028"));
      await assert.rejects(cache.invalidate(42 as never), isCode("IL6028"));
    });
  });
}

cacheContract("memory", () => createCache(memoryCacheStore(), "memory"));

describe("memory cache store", () => {
  test("keeps at most maxEntries, removing the least recently used first", async () => {
    const cache = createCache(memoryCacheStore(2), "memory");
    await cache.set("a", 1, { ttlMs: 60_000 });
    await cache.set("b", 2, { ttlMs: 60_000 });
    await cache.get("a"); // a is now the most recently used
    await cache.set("c", 3, { ttlMs: 60_000 });
    assert.equal(await cache.get("a"), 1);
    assert.equal(await cache.get("b"), undefined);
    assert.equal(await cache.get("c"), 3);
    await cache.clear();
    assert.equal(await cache.get("a"), undefined);
  });

  test("callers cannot change a cached value through the object they stored or got", async () => {
    const cache = createCache(memoryCacheStore(), "memory");
    const value = { n: 1 };
    await cache.set("v", value, { ttlMs: 60_000 });
    value.n = 2;
    const got = await cache.get<{ n: number }>("v");
    got!.n = 3;
    assert.deepEqual(await cache.get("v"), { n: 1 });
  });
});

describe("cache in apps", () => {
  test("ctx.cache in routes, jobs and app.cache are the same cache", async () => {
    let computed = 0;
    const stats = route.get("/stats", { auth: "public" }).handle(({ cache }) =>
      cache.getOrSet("stats", { ttlMs: 60_000, tags: ["tickets"] }, () => ({ computed: ++computed })),
    );
    const close = route.post("/tickets/close", { auth: "public" }).handle(async ({ cache, status }) => {
      await cache.invalidate("tickets");
      status(204);
    });
    const warm = job("warm-cache", { input: t.object({}) }).handle(async ({ cache }) => {
      await cache.set("warmed", true, { ttlMs: 60_000 });
    });
    const app = createApp({ routes: [{ stats, close }], jobs: [warm], logger: quiet });
    assert.equal(app.cache.store, "memory");
    assert.deepEqual(await (await app.request("/stats")).json(), { computed: 1 });
    assert.deepEqual(await (await app.request("/stats")).json(), { computed: 1 });
    assert.deepEqual(await app.cache.get("stats"), { computed: 1 });
    assert.equal((await app.request("/tickets/close", { method: "POST" })).status, 204);
    assert.deepEqual(await (await app.request("/stats")).json(), { computed: 2 });
    await app.jobs.enqueue(warm, {});
    await app.jobs.runDue();
    assert.equal(await app.cache.get("warmed"), true);
    assert.equal(app.describe().cache, "memory");
  });

  test("invalid createApp({ cache }) options raise IL6028", () => {
    const cases: unknown[] = [null, "memory", { store: "redis" }, { maxEntries: 0 }, { maxEntries: 1.5 }, { ttl: 1 }, { store: "database" }];
    for (const cache of cases) {
      assert.throws(() => createApp({ cache: cache as CacheConfig, logger: quiet }), isCode("IL6028"), JSON.stringify(cache));
    }
    assert.throws(() => createApp({ db: memory(), cache: { store: "database" } }), (e: unknown) => isCode("IL6028")(e) && /memory adapter/.test((e as Error).message));
    assert.doesNotThrow(() => createApp({ cache: { store: "memory", maxEntries: 100 }, logger: quiet }));
  });
});

if (PG_URL) {
  const adapters: Adapter[] = [];
  const pg = () => {
    const a = postgres({ url: PG_URL });
    adapters.push(a);
    return a;
  };
  after(async () => {
    for (const a of adapters) await a.close?.();
  });
  cacheContract("database", () => createApp({ db: pg(), cache: { store: "database" }, logger: quiet }).cache);

  describe("database cache store", () => {
    test("entries are shared by every instance of the app", async () => {
      const first = createApp({ db: pg(), cache: { store: "database" }, logger: quiet });
      const second = createApp({ db: pg(), cache: { store: "database" }, logger: quiet });
      assert.equal(first.cache.store, "database");
      await first.cache.set(`shared-${suffix}`, { from: "first" }, { ttlMs: 60_000, tags: [`shared-${suffix}`] });
      assert.deepEqual(await second.cache.get(`shared-${suffix}`), { from: "first" });
      await second.cache.invalidate(`shared-${suffix}`);
      assert.equal(await first.cache.get(`shared-${suffix}`), undefined);
      assert.equal(first.describe().cache, "database");
    });
  });
}
