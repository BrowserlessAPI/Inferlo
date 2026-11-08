// Idempotency keys (route option idempotency), on the memory store, and on the database and Redis stores when
// INFERLO_TEST_DATABASE_URL and INFERLO_TEST_REDIS_URL are set.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { bearer, createApp, InferloError, route, t, type Adapter, type CacheConfig, type RedisClient } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { databaseCacheStore, memoryCacheStore, type CacheStore } from "../src/cache.ts";
import { redisCacheStore } from "../src/redis.ts";
import { createClient } from "redis";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alice = { id: "user-alice", email: "alice@example.com", roles: [] };
const bob = { id: "user-bob", email: "bob@example.com", roles: [] };
const auth = bearer(() => null);

describe("idempotency option", () => {
  test("is checked at startup (IL6058)", () => {
    const make = (path: string, method: "get" | "post", option: unknown) => () => createApp({ routes: [route[method](path, { idempotency: option as never }).handle(() => ({}))], auth, logger: quiet });
    assert.throws(make("/a", "get", true), (e: unknown) => isCode("IL6058")(e) && /only POST, PUT, PATCH and DELETE/.test((e as Error).message));
    for (const option of [false, "yes", [], { ttlMs: 10 }, { ttlMs: 31 * 86_400_000 }, { ttlMs: 1.5e3 + 0.5 }, { required: "yes" }, { scope: "user" }]) {
      assert.throws(make("/b", "post", option), isCode("IL6058"), JSON.stringify(option));
    }
    assert.doesNotThrow(make("/c", "post", true));
    assert.doesNotThrow(make("/d", "post", { ttlMs: 60_000, required: true }));
    for (const method of ["put", "patch", "delete"] as const) {
      assert.doesNotThrow(() => createApp({ routes: [route[method]("/e", { idempotency: true }).handle(() => ({}))], auth, logger: quiet }));
    }
  });

  test("is shown in OpenAPI as the Idempotency-Key header", async () => {
    const orders = route.post("/orders", { idempotency: { required: true }, body: t.object({ sku: t.string() }) }).handle(({ body }) => body);
    const notes = route.post("/notes", { idempotency: true }).handle(() => ({}));
    const app = createApp({ routes: [orders, notes], auth, logger: quiet });
    const doc = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, { post: { parameters: { name: string; in: string; required: boolean }[]; responses: Record<string, unknown> } }> };
    assert.deepEqual(doc.paths["/orders"]!.post.parameters.map((p) => [p.name, p.in, p.required]), [["Idempotency-Key", "header", true]]);
    assert.deepEqual(doc.paths["/notes"]!.post.parameters.map((p) => [p.name, p.in, p.required]), [["Idempotency-Key", "header", false]]);
    assert.ok(doc.paths["/orders"]!.post.responses["409"]);
  });
});

/** The same behaviour for every cache store. */
function contract(name: string, makeConfig: () => { db?: Adapter; redis?: RedisClient; name?: string; cache?: CacheConfig }) {
  describe(`idempotency keys (${name} store)`, () => {
    let runs = 0;
    let delayMs = 0;
    let fail: "throw" | "500" | null = null;
    const order = route.post("/orders", { idempotency: true, body: t.object({ sku: t.string(), qty: t.int() }) }).handle(async ({ body, status, header }) => {
      runs++;
      if (delayMs) await sleep(delayMs);
      if (fail === "throw") throw new Error("payment provider down");
      if (fail === "500") return new Response(JSON.stringify({ retry: true }), { status: 500, headers: { "content-type": "application/json" } });
      status(201);
      header("location", `/orders/${runs}`);
      return { order: runs, ...body };
    });
    const strict = route.post("/payments", { idempotency: { required: true, ttlMs: 1000 } }).handle(() => ({ paid: ++runs }));
    const login = route.post("/login", { auth: "public", idempotency: true }).handle(({ header }) => {
      header("set-cookie", "session=secret; HttpOnly");
      return { ok: ++runs };
    });
    const app = createApp({ ...makeConfig(), routes: [order, strict, login], auth, logger: quiet });
    const post = (path: string, key: string | null, json: unknown = { sku: "a", qty: 1 }, as: typeof alice | null = alice) =>
      app.request(path, { method: "POST", json, headers: key === null ? {} : { "idempotency-key": key }, as });

    test("a repeat gets the first answer, without running again", async () => {
      runs = 0;
      const key = `k1-${suffix}`;
      const first = await post("/orders", key);
      assert.equal(first.status, 201);
      assert.equal(first.headers.get("location"), "/orders/1");
      assert.equal(first.headers.get("idempotent-replayed"), null);
      const firstBody = await first.json();
      const again = await post("/orders", key);
      assert.equal(again.status, 201);
      assert.equal(again.headers.get("idempotent-replayed"), "true");
      assert.equal(again.headers.get("location"), "/orders/1");
      assert.ok(again.headers.get("x-request-id"));
      assert.notEqual(again.headers.get("x-request-id"), first.headers.get("x-request-id"));
      assert.equal(again.headers.get("x-content-type-options"), "nosniff", "secure headers on replays too");
      assert.deepEqual(await again.json(), firstBody);
      assert.equal(runs, 1);
    });

    test("without a key, every request runs", async () => {
      runs = 0;
      await post("/orders", null);
      await post("/orders", null);
      assert.equal(runs, 2);
    });

    test("keys belong to one user", async () => {
      runs = 0;
      const key = `k2-${suffix}`;
      assert.deepEqual(await (await post("/orders", key, undefined, alice)).json(), { order: 1, sku: "a", qty: 1 });
      assert.deepEqual(await (await post("/orders", key, undefined, bob)).json(), { order: 2, sku: "a", qty: 1 });
      assert.equal(runs, 2);
    });

    test("a key used for a different request answers 422 IL2019", async () => {
      const key = `k3-${suffix}`;
      assert.equal((await post("/orders", key, { sku: "a", qty: 1 })).status, 201);
      const other = await post("/orders", key, { sku: "a", qty: 2 });
      assert.equal(other.status, 422);
      assert.equal(((await other.json()) as { error: { code: string } }).error.code, "IL2019");
    });

    test("a repeat while the first request runs answers 409 IL2018", async () => {
      runs = 0;
      delayMs = 300;
      try {
        const key = `k4-${suffix}`;
        const first = post("/orders", key);
        await sleep(100);
        const concurrent = await post("/orders", key);
        assert.equal(concurrent.status, 409);
        assert.equal(((await concurrent.json()) as { error: { code: string } }).error.code, "IL2018");
        assert.equal((await first).status, 201);
        assert.equal((await post("/orders", key)).headers.get("idempotent-replayed"), "true");
        assert.equal(runs, 1);
      } finally {
        delayMs = 0;
      }
    });

    test("errors and 5xx answers release the key, so the request can be retried", async () => {
      runs = 0;
      const key = `k5-${suffix}`;
      try {
        fail = "throw";
        assert.equal((await post("/orders", key)).status, 500);
        fail = "500";
        assert.equal((await post("/orders", key)).status, 500);
        fail = null;
        assert.equal((await post("/orders", key)).status, 201);
        assert.equal((await post("/orders", key)).headers.get("idempotent-replayed"), "true");
        assert.equal(runs, 3);
      } finally {
        fail = null;
      }
    });

    test("required keys (IL2017), invalid keys, and ttlMs", async () => {
      runs = 0;
      const missing = await post("/payments", null);
      assert.equal(missing.status, 400);
      assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "IL2017");
      const invalid = await post("/payments", "x".repeat(256));
      assert.equal(invalid.status, 400);
      assert.equal((await post("/payments", "has space")).status, 400);
      const key = `k6-${suffix}`;
      assert.deepEqual(await (await post("/payments", key)).json(), { paid: 1 });
      assert.deepEqual(await (await post("/payments", key)).json(), { paid: 1 });
      await sleep(1300);
      assert.deepEqual(await (await post("/payments", key)).json(), { paid: 2 }, "runs again after ttlMs");
    });

    test("answers that set a cookie are not replayed", async () => {
      runs = 0;
      const key = `k7-${suffix}`;
      const first = await post("/login", key, {}, null);
      assert.equal(first.status, 200);
      assert.ok(first.headers.get("set-cookie"));
      const again = await post("/login", key, {}, null);
      assert.equal(again.status, 409);
      assert.equal(again.headers.get("set-cookie"), null);
      assert.equal(runs, 1);
    });
  });
}

contract("memory", () => ({}));

/** CacheStore.add stores only over a missing or expired entry. */
function addContract(name: string, makeStore: () => CacheStore) {
  test(`${name} cache store: add() is atomic and ignores expired entries`, async () => {
    const store = makeStore();
    const key = `add-${name}-${suffix}`;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add(key, JSON.stringify(i), 400)));
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.indexOf(true);
    assert.equal(await store.get(key), JSON.stringify(winner));
    await sleep(600);
    assert.equal(await store.add(key, '"again"', 60_000), true, "an expired entry is replaced");
    assert.equal(await store.get(key), '"again"');
    await store.delete(key);
  });
}

addContract("memory", () => memoryCacheStore());

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
  contract("database", () => ({ db: pg(), cache: { store: "database" } }));
  addContract("database", () => databaseCacheStore(pg()));
}

if (REDIS_URL) {
  const connected = createClient({ url: REDIS_URL }).connect();
  const redis: RedisClient = { sendCommand: async (args) => (await connected).sendCommand(args) };
  after(async () => {
    await (await connected).close();
  });
  contract("redis", () => ({ name: `idem-${suffix}`, redis, cache: { store: "redis" } }));
  addContract("redis", () => redisCacheStore(redis, `inferlo:idem-add-${suffix}:`));
}
