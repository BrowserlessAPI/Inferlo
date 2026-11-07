import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { bearer, createApp, InferloError, memory, route, t, type Adapter } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";
import { memoryRateLimitStore } from "../src/rate-limit.ts";
import { createClient } from "redis";
import type { RedisClient } from "../src/redis.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;

const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] }, bob: { id: "bob", roles: [] } };

type Store = "memory" | "database" | "redis";

function makeApp(db: Adapter = memory(), store: Store = "memory", redis?: RedisClient) {
  const login = route
    .post("/login", { auth: "public", body: t.object({ email: t.string() }), rateLimit: { max: 2, per: "minute", by: "ip" } })
    .handle(() => ({ ok: true }));
  const ask = route.post("/ask", { rateLimit: { max: 3, per: "hour" } }).handle(() => ({ answer: 42 }));
  const search = route.get("/search", { auth: "public", rateLimit: { max: 1, per: "second" } }).handle(() => []);
  const free = route.get("/free", { auth: "public" }).handle(() => ({ ok: true }));
  return createApp({
    routes: [{ login, ask, search, free }],
    db,
    redis,
    rateLimit: { store },
    trustProxy: true,
    auth: bearer((token) => users[token] ?? null),
    logger: { info() {}, error() {} },
  });
}

const post = (app: ReturnType<typeof makeApp>, path: string, headers: Record<string, string>, json?: unknown) => app.request(path, { method: "POST", headers, json });

const stores: [string, () => { db: Adapter; store: Store; redis?: RedisClient; close?: () => Promise<unknown> }][] = [["memory", () => ({ db: memory(), store: "memory" })]];
if (PG_URL) stores.push(["database", () => ({ db: postgres({ url: PG_URL }), store: "database" })]);
if (PG_URL) stores.push(["database (postgres.js)", () => ({ db: postgresJsAdapter(PG_URL), store: "database" })]);
if (REDIS_URL) {
  stores.push([
    "redis",
    () => {
      const connected = createClient({ url: REDIS_URL }).connect();
      return {
        db: memory(),
        store: "redis",
        redis: { sendCommand: async (args) => (await connected).sendCommand(args) },
        close: async () => (await connected).close(),
      };
    },
  ]);
}

for (const [name, make] of stores) {
  describe(`rate limiting (${name} store)`, () => {
    const { db, store, redis, close } = make();
    const app = makeApp(db, store, redis);
    const run = `${name}-${Date.now()}-${Math.random()}`;
    after(async () => {
      await app.db.$close();
      await close?.();
    });

    test("by ip: allows max requests per window, then 429 with IL2005 and Retry-After", async () => {
      const ip = { "x-forwarded-for": `10.0.0.1-${run}, 172.16.0.1` };
      const first = await post(app, "/login", ip, { email: "a" });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("ratelimit-limit"), "2");
      assert.equal(first.headers.get("ratelimit-remaining"), "1");
      assert.ok(Number(first.headers.get("ratelimit-reset")) > 0 && Number(first.headers.get("ratelimit-reset")) <= 60);
      assert.equal((await post(app, "/login", ip, { email: "a" })).status, 200);
      const blocked = await post(app, "/login", ip, { email: "a" });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("ratelimit-remaining"), "0");
      const retry = Number(blocked.headers.get("retry-after"));
      assert.ok(retry >= 1 && retry <= 60, `retry-after ${retry}`);
      const body = await blocked.json();
      assert.equal(body.error.code, "IL2005");
      assert.match(body.error.message, /Too many requests/);
      assert.match(body.error.fix, /2 requests per minute/);
      // Invalid bodies count too, so they cannot be used to probe without limits.
      assert.equal((await post(app, "/login", ip, {})).status, 429);
      // Another IP has its own count.
      assert.equal((await post(app, "/login", { "x-forwarded-for": `10.0.0.2-${run}` }, { email: "a" })).status, 200);
    });

    test("by user (the default): each signed-in user has their own count, failed sign-ins do not count", async () => {
      const key = `${run}-user`;
      users[`a${key}`] = { id: `alice-${key}`, roles: [] };
      users[`b${key}`] = { id: `bob-${key}`, roles: [] };
      for (let i = 0; i < 3; i++) assert.equal((await post(app, "/ask", { authorization: `Bearer a${key}` })).status, 200);
      assert.equal((await post(app, "/ask", { authorization: "Bearer nobody" })).status, 401);
      assert.equal((await post(app, "/ask", { authorization: `Bearer a${key}` })).status, 429);
      // Same IP, other user: not limited.
      assert.equal((await post(app, "/ask", { authorization: `Bearer b${key}` })).status, 200);
    });

    test("the window resets", async () => {
      const ip = { "x-forwarded-for": `10.0.0.3-${run}` };
      assert.equal((await app.request("/search", { headers: ip })).status, 200);
      assert.equal((await app.request("/search", { headers: ip })).status, 429);
      await new Promise((r) => setTimeout(r, 1100));
      assert.equal((await app.request("/search", { headers: ip })).status, 200);
    });

    test("routes without rateLimit send no rate limit headers", async () => {
      const res = await app.request("/free");
      assert.equal(res.headers.get("ratelimit-limit"), null);
    });
  });
}

describe("rate limiting configuration", () => {
  test("invalid rateLimit options raise IL6007 at startup", () => {
    const bad = (rateLimit: unknown) => () => createApp({ routes: [route.get("/x", { auth: "public", rateLimit: rateLimit as never }).handle(() => 1)] });
    for (const value of [{ max: 0, per: "minute" }, { max: 1.5, per: "minute" }, { max: 5, per: "week" }, { max: 5, per: "minute", by: "email" }, "10/min"]) {
      assert.throws(bad(value), (e: unknown) => e instanceof InferloError && e.code === "IL6007", JSON.stringify(value));
    }
    assert.throws(() => createApp({ rateLimit: { store: "mongodb" as never } }), (e: unknown) => e instanceof InferloError && e.code === "IL6007");
  });

  test('store "database" needs Postgres (IL6008)', () => {
    assert.throws(() => createApp({ rateLimit: { store: "database" } }), (e: unknown) => e instanceof InferloError && e.code === "IL6008");
  });

  test("without trustProxy, X-Forwarded-For is ignored", async () => {
    const app = createApp({ routes: [route.get("/x", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => 1)] });
    assert.equal((await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } })).status, 200);
    assert.equal((await app.request("/x", { headers: { "x-forwarded-for": "2.2.2.2" } })).status, 429);
  });

  test("the client IP comes from the server: Bun requestIP, Deno remoteAddr, Node serve()", async () => {
    const app = createApp({ routes: [route.get("/x", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => 1)] });
    const bun = (address: string) => ({ requestIP: () => ({ address }) });
    assert.equal((await app.fetch(new Request("http://a/x"), bun("1.1.1.1"))).status, 200);
    assert.equal((await app.fetch(new Request("http://a/x"), bun("1.1.1.1"))).status, 429);
    assert.equal((await app.fetch(new Request("http://a/x"), { remoteAddr: { hostname: "2.2.2.2" } })).status, 200);
    assert.equal((await app.fetch(new Request("http://a/x"), { remoteAddr: { hostname: "2.2.2.2" } })).status, 429);

    const server = await app.listen(0, "127.0.0.1");
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/x`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/x`)).status, 429);
    } finally {
      await server.close();
    }
  });

  test("memory store counts fixed windows", async () => {
    let now = 1000;
    const store = memoryRateLimitStore(() => now);
    assert.deepEqual(await store.hit("k", 60_000), { count: 1, resetMs: 60_000 });
    now += 30_000;
    assert.deepEqual(await store.hit("k", 60_000), { count: 2, resetMs: 30_000 });
    now += 30_000;
    assert.deepEqual(await store.hit("k", 60_000), { count: 1, resetMs: 60_000 });
  });

  test("describe and OpenAPI show the limit", () => {
    const app = createApp({ routes: [{ x: route.get("/x", { auth: "public", rateLimit: { max: 5, per: "minute" } }).handle(() => 1) }] });
    assert.deepEqual(app.describe().routes[0]!.rateLimit, { max: 5, per: "minute", by: "user" });
    const op = (app.openapi() as any).paths["/x"].get;
    assert.match(op.responses["429"].description, /IL2005/);
  });
});
