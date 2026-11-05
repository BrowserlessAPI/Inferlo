import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { bearer, createApp, InferloError, job, memory, route, t, type Adapter, type Cache, type CacheConfig } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { createCache, memoryCacheStore } from "../src/cache.ts";
import type { RedisClient } from "../src/redis.ts";
import { createClient } from "redis";

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
    const cases: unknown[] = [null, "memory", { store: "mongodb" }, { maxEntries: 0 }, { maxEntries: 1.5 }, { ttl: 1 }, { store: "database" }];
    for (const cache of cases) {
      assert.throws(() => createApp({ cache: cache as CacheConfig, logger: quiet }), isCode("IL6028"), JSON.stringify(cache));
    }
    assert.throws(() => createApp({ db: memory(), cache: { store: "database" } }), (e: unknown) => isCode("IL6028")(e) && /memory adapter/.test((e as Error).message));
    assert.doesNotThrow(() => createApp({ cache: { store: "memory", maxEntries: 100 }, logger: quiet }));
  });
});

describe("route response caching", () => {
  const people: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: ["admin"] }, bob: { id: "bob", roles: [] } };
  const makeApp = () => {
    const calls = { mine: 0, catalog: 0, status: 0 };
    const mine = route
      .get("/mine", { cache: { ttlMs: 60_000, tags: ["notes"] }, query: t.object({ page: t.int().default(1) }) })
      .handle(({ user, query, header }) => {
        calls.mine++;
        header("x-total", "7");
        return { user: user.id, page: query.page, call: calls.mine, at: new Date("2030-01-01T00:00:00Z") };
      });
    const catalog = route.get("/catalog", { auth: "public", cache: { ttlMs: 60_000, by: "public" } }).handle(() => ({ call: ++calls.catalog }));
    const created = route.get("/status-created", { auth: "public", cache: { ttlMs: 60_000, by: "public" } }).handle(({ status }) => {
      status(201);
      return { call: ++calls.status };
    });
    const cookie = route.get("/cookie", { auth: "public", cache: { ttlMs: 60_000, by: "public" } }).handle(({ header }) => {
      header("set-cookie", "a=1");
      return { call: ++calls.status };
    });
    const admin = route.get("/admin-report", { auth: "admin", cache: { ttlMs: 60_000, by: "public" } }).handle(() => ({ report: true }));
    const limited = route.get("/limited", { auth: "public", rateLimit: { max: 2, per: "minute", by: "ip" }, cache: { ttlMs: 60_000, by: "public" } }).handle(() => ({ ok: true }));
    const app = createApp({ routes: [{ mine, catalog, created, cookie, admin, limited }], auth: bearer((token) => people[token] ?? null), logger: quiet });
    return { app, calls };
  };
  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  test("a cached route runs its handler once per user and URL, and replays the handler's headers", async () => {
    const { app, calls } = makeApp();
    const first = await app.request("/mine?page=2", as("alice"));
    assert.equal(first.headers.get("x-inferlo-cache"), "MISS");
    assert.equal(first.headers.get("cache-control"), "private, no-cache");
    assert.match(String(first.headers.get("vary")), /Authorization/);
    const body = await first.json();
    assert.deepEqual(body, { user: "alice", page: 2, call: 1, at: "2030-01-01T00:00:00.000Z" });
    const second = await app.request("/mine?page=2", as("alice"));
    assert.equal(second.headers.get("x-inferlo-cache"), "HIT");
    assert.equal(second.headers.get("x-total"), "7", "headers the handler set are replayed");
    assert.ok(second.headers.get("x-request-id"), "per-request headers are fresh");
    assert.deepEqual(await second.json(), body);
    assert.equal(calls.mine, 1);
    assert.equal((await (await app.request("/mine?page=2", as("bob"))).json()).user, "bob", "never another user's response");
    assert.equal((await (await app.request("/mine?page=3", as("alice"))).json()).call, 3, "the query is part of the key");
    assert.equal((await app.request("/mine")).status, 401, "auth runs before the cache");
    assert.equal((await app.request("/mine?page=x", as("alice"))).status, 422, "validation runs before the cache");
  });

  test("ETags answer If-None-Match with 304, and invalidate() removes cached responses", async () => {
    const { app, calls } = makeApp();
    const first = await app.request("/mine", as("alice"));
    const etag = first.headers.get("etag")!;
    assert.match(etag, /^W\/"/);
    const notModified = await app.request("/mine", { headers: { authorization: "Bearer alice", "if-none-match": etag } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    await app.cache.invalidate("notes");
    const fresh = await app.request("/mine", { headers: { authorization: "Bearer alice", "if-none-match": etag } });
    assert.equal(fresh.status, 200, "the handler ran again and the body changed");
    assert.equal(fresh.headers.get("x-inferlo-cache"), "MISS");
    assert.equal(calls.mine, 2);
  });

  test("by: \"public\" shares one response; only 200 answers without cookies are cached", async () => {
    const { app, calls } = makeApp();
    assert.deepEqual(await (await app.request("/catalog")).json(), { call: 1 });
    const hit = await app.request("/catalog", as("bob"));
    assert.deepEqual(await hit.json(), { call: 1 });
    assert.equal(hit.headers.get("cache-control"), "public, no-cache");
    assert.equal(hit.headers.get("vary"), null);
    const head = await app.request("/catalog", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(calls.catalog, 1);
    await app.request("/status-created");
    await app.request("/status-created");
    assert.equal(calls.status, 2, "201 is not cached");
    await app.request("/cookie");
    await app.request("/cookie");
    assert.equal(calls.status, 4, "a response that sets a cookie is not cached");
  });

  test("roles and rate limits still apply to cached responses", async () => {
    const { app } = makeApp();
    assert.equal((await app.request("/admin-report", as("alice"))).status, 200);
    assert.equal((await app.request("/admin-report", as("bob"))).status, 403);
    assert.equal((await app.request("/limited")).status, 200);
    assert.equal((await app.request("/limited")).status, 200);
    assert.equal((await app.request("/limited")).status, 429);
  });

  test("describe and OpenAPI show the cache; invalid options raise IL6028 at startup", () => {
    const { app } = makeApp();
    assert.deepEqual(app.describe().routes.find((r) => r.path === "/mine")?.cache, { ttlMs: 60_000, by: "user", tags: ["notes"] });
    assert.deepEqual((app.openapi() as any).paths["/catalog"].get["x-inferlo-cache"], { ttlMs: 60_000, by: "public", tags: [] });
    const cases: [string, unknown][] = [
      ["post", { ttlMs: 1000 }],
      ["get", { ttlMs: 0 }],
      ["get", { ttlMs: 1000, by: "everyone" }],
      ["get", { ttlMs: 1000, tags: "notes" }],
      ["get", { ttl: 1000 }],
      ["get", null],
    ];
    for (const [method, cache] of cases) {
      const r = (route as any)[method]("/x", { auth: "public", cache }).handle(() => ({}));
      assert.throws(() => createApp({ routes: [{ r }], logger: quiet }), isCode("IL6028"), `${method} ${JSON.stringify(cache)}`);
    }
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

    test("cached route responses are shared by every instance", async () => {
      let calls = 0;
      const shared = route.get(`/shared-${suffix}`, { auth: "public", cache: { ttlMs: 60_000, by: "public", tags: [`route-${suffix}`] } }).handle(() => ({ call: ++calls }));
      const make = () => createApp({ db: pg(), routes: [{ shared }], cache: { store: "database" }, logger: quiet });
      const first = await make().request(`/shared-${suffix}`);
      assert.equal(first.headers.get("x-inferlo-cache"), "MISS");
      const second = await make().request(`/shared-${suffix}`);
      assert.equal(second.headers.get("x-inferlo-cache"), "HIT");
      assert.equal(second.headers.get("etag"), first.headers.get("etag"));
      assert.deepEqual(await second.json(), { call: 1 });
      await make().cache.invalidate(`route-${suffix}`);
      assert.deepEqual(await (await make().request(`/shared-${suffix}`)).json(), { call: 2 });
    });
  });
}

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
if (REDIS_URL) {
  const connected = createClient({ url: REDIS_URL }).connect();
  const redis: RedisClient = { sendCommand: async (args) => (await connected).sendCommand(args) };
  after(async () => {
    await (await connected).close();
  });
  cacheContract("redis", () => createApp({ name: `cache-${suffix}`, redis, cache: { store: "redis" }, logger: quiet }).cache);

  describe("redis cache store", () => {
    test("entries and invalidation are shared by every instance of the app", async () => {
      const make = () => createApp({ name: `shared-${suffix}`, redis, cache: { store: "redis" }, logger: quiet });
      const [first, second] = [make(), make()];
      assert.equal(first.cache.store, "redis");
      assert.equal(first.describe().cache, "redis");
      await first.cache.set("report", { from: "first" }, { ttlMs: 60_000, tags: ["reports"] });
      assert.deepEqual(await second.cache.get("report"), { from: "first" });
      await second.cache.invalidate("reports");
      assert.equal(await first.cache.get("report"), undefined);
    });

    test("cached route responses are shared by every instance", async () => {
      let calls = 0;
      const shared = route.get("/shared", { auth: "public", cache: { ttlMs: 60_000, by: "public", tags: ["routes"] } }).handle(() => ({ call: ++calls }));
      const make = () => createApp({ name: `routes-${suffix}`, routes: [{ shared }], redis, cache: { store: "redis" }, logger: quiet });
      assert.equal((await make().request("/shared")).headers.get("x-inferlo-cache"), "MISS");
      const second = await make().request("/shared");
      assert.equal(second.headers.get("x-inferlo-cache"), "HIT");
      assert.deepEqual(await second.json(), { call: 1 });
      await make().cache.invalidate("routes");
      assert.deepEqual(await (await make().request("/shared")).json(), { call: 2 });
    });

    test("apps sharing one Redis keep their entries apart, and clear() removes only the app's own", async () => {
      const a = createApp({ name: `a*[${suffix}]`, redis, cache: { store: "redis" }, logger: quiet }).cache;
      const b = createApp({ name: `b-${suffix}`, redis, cache: { store: "redis" }, logger: quiet }).cache;
      for (let i = 0; i < 1200; i++) await a.set(`k${i}`, i, { ttlMs: 60_000, tags: ["many"] });
      await b.set("k1", "b", { ttlMs: 60_000 });
      assert.equal(await a.get("k1"), 1);
      assert.equal(await b.get("k1"), "b");
      await a.clear();
      assert.equal(await a.get("k1"), undefined);
      assert.equal(await a.get("k1199"), undefined);
      assert.equal(await b.get("k1"), "b");
      const left = (await (await connected).keys(`inferlo:a\\*\\[${suffix}\\]:*`)).length;
      assert.equal(left, 0, "no entries or tag sets are left");
    });

    test("tag sets expire with their longest-lived entry", async () => {
      const cache = createApp({ name: `ttl-${suffix}`, redis, cache: { store: "redis" }, logger: quiet }).cache;
      await cache.set("short", 1, { ttlMs: 50, tags: ["t"] });
      await cache.set("long", 2, { ttlMs: 60_000, tags: ["t"] });
      const ttl = await (await connected).pTTL(`inferlo:ttl-${suffix}:cache:tag:t`);
      assert.ok(ttl > 50_000, `tag set ttl ${ttl}`);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(await cache.get("short"), undefined);
      assert.equal(await cache.get("long"), 2);
    });
  });
}
