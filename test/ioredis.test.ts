// Inferlo's Redis features on an ioredis connection (@browserlessapi/inferlo/ioredis): rate limits, cache, idempotency
// keys, the job queue, the Redis Streams event transport, WebSocket broadcasts across instances and readiness, against
// a real Redis when INFERLO_TEST_REDIS_URL is set. The argument checks run without Redis.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Redis } from "ioredis";
import { bearer, createApp, event, InferloError, job, memory, on, route, t, type AppUser } from "../src/index.ts";
import { ioredisClient, ioredisSubscriber } from "../src/ioredis.ts";

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };
const run = `io${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const ada: AppUser = { id: "ada" };

const isError = (code: string, pattern?: RegExp) => (error: unknown) => error instanceof InferloError && error.code === code && (!pattern || pattern.test(`${error.message} ${error.fix ?? ""}`));

describe("ioredis arguments", () => {
  const offline = () => new Redis({ lazyConnect: true, enableOfflineQueue: false });

  test("ioredisClient and ioredisSubscriber need ioredis connections (IL6064)", () => {
    for (const value of [undefined, null, "redis://localhost", {}, { sendCommand() {} }, []]) {
      assert.throws(() => ioredisClient(value as never), isError("IL6064", /ioredisClient\(new Redis/), String(value));
      assert.throws(() => ioredisSubscriber(value as never), isError("IL6064", /ioredisSubscriber\(connection\.duplicate\(\)\)/), String(value));
    }
  });

  test("one connection cannot be both the client and the subscriber (IL6064)", () => {
    const a = offline();
    ioredisClient(a);
    assert.throws(() => ioredisSubscriber(a), isError("IL6064", /second/));
    const b = offline();
    ioredisSubscriber(b);
    assert.throws(() => ioredisClient(b), isError("IL6064", /subscribed/));
  });

  test("a connection with keyPrefix raises IL6064", () => {
    assert.throws(() => ioredisClient(new Redis({ lazyConnect: true, keyPrefix: "app:" })), isError("IL6064", /keyPrefix: ""/));
    assert.ok(ioredisClient(new Redis({ lazyConnect: true, keyPrefix: "app:" }).duplicate({ keyPrefix: "" })));
  });

  test("an ioredis connection passed directly raises IL6065 with the wrapper to use", () => {
    assert.throws(() => createApp({ redis: offline() as never, logger: quiet }), isError("IL6065", /ioredisClient\(connection\)/));
    assert.throws(
      () => createApp({ name: "x", redis: ioredisClient(offline()), sockets: { transport: "redis", subscriber: offline() as never }, logger: quiet }),
      isError("IL6065", /ioredisSubscriber\(connection\.duplicate\(\)\)/),
    );
  });
});

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(REDIS_URL ? describe : describe.skip)("Inferlo on ioredis", () => {
  const connections: Redis[] = [];
  const connect = () => {
    const connection = new Redis(REDIS_URL!, { lazyConnect: false });
    connections.push(connection);
    return connection;
  };
  const connection = REDIS_URL ? connect() : (undefined as never);
  const redis = REDIS_URL ? ioredisClient(connection) : (undefined as never);

  after(async () => {
    const keys = await connection.keys(`inferlo:*${run}*`);
    if (keys.length) await connection.del(...keys);
    for (const c of connections) c.disconnect();
  });

  test("readiness sends PING through ioredis", async () => {
    const app = createApp({ name: `ready-${run}`, redis, health: true, logger: quiet });
    const res = await app.request("/ready");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).checks.redis.status, "ok");
  });

  test("rate limits are counted in Redis and shared by every instance", async () => {
    const login = route.post("/login", { auth: "public", rateLimit: { max: 2, per: "minute", by: "ip" } }).handle(() => ({ ok: true }));
    const make = () => createApp({ name: `rl-${run}`, routes: [{ login }], redis, rateLimit: { store: "redis" }, trustProxy: true, logger: quiet });
    const headers = { "x-forwarded-for": `10.1.2.3` };
    const [a, b] = [make(), make()];
    assert.equal((await a.request("/login", { method: "POST", headers })).status, 200);
    assert.equal((await b.request("/login", { method: "POST", headers })).status, 200);
    const blocked = await a.request("/login", { method: "POST", headers });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, "IL2005");
  });

  test("the cache is shared, invalidated by tag and cleared per app", async () => {
    const make = () => createApp({ name: `cache-${run}`, redis, cache: { store: "redis" }, logger: quiet });
    const [a, b] = [make(), make()];
    await a.cache.set("report", { total: 3, at: new Date(0) }, { ttlMs: 60_000, tags: ["reports"] });
    assert.deepEqual(await b.cache.get("report"), { total: 3, at: "1970-01-01T00:00:00.000Z" });
    let computed = 0;
    assert.equal(await b.cache.getOrSet("count", { ttlMs: 60_000 }, () => ++computed), 1);
    assert.equal(await a.cache.getOrSet("count", { ttlMs: 60_000 }, () => ++computed), 1, "computed once");
    await b.cache.invalidate("reports");
    assert.equal(await a.cache.get("report"), undefined);
    for (let i = 0; i < 30; i++) await a.cache.set(`k${i}`, i, { ttlMs: 60_000 });
    await a.cache.clear();
    assert.equal(await b.cache.get("k1"), undefined);
    assert.equal(await b.cache.get("count"), undefined);
  });

  test("idempotency keys answer retries with the first answer", async () => {
    let charges = 0;
    const charge = route.post("/charges", { idempotency: true, body: t.object({ amount: t.int() }) }).handle(({ body }) => ({ charge: ++charges, amount: body.amount }));
    const make = () => createApp({ name: `idem-${run}`, routes: [{ charge }], auth: bearer(() => null), redis, cache: { store: "redis" }, logger: quiet });
    const headers = { "idempotency-key": `key-${run}` };
    const first = await make().request("/charges", { method: "POST", json: { amount: 5 }, headers, as: ada });
    const retry = await make().request("/charges", { method: "POST", json: { amount: 5 }, headers, as: ada });
    assert.equal(first.status, 200);
    assert.deepEqual(await retry.json(), await first.json());
    assert.equal(charges, 1);
    const reused = await make().request("/charges", { method: "POST", json: { amount: 6 }, headers, as: ada });
    assert.equal(reused.status, 422);
  });

  test("jobs are queued in Redis, claimed once and retried", async () => {
    const ran: string[] = [];
    const work = job(`io-work-${run}`, { input: t.object({ n: t.int() }), retries: 1 }).handle(({ input, attempt }) => {
      ran.push(`${input.n}:${attempt}`);
      if (input.n < 0 && attempt === 1) throw new Error("first attempt fails");
    });
    const make = () => createApp({ name: `jobs-${run}`, redis, jobs: [work], jobQueue: { store: "redis" }, logger: quiet });
    const [web, worker, other] = [make(), make(), make()];
    const queued = await web.jobs.enqueue(work, { n: 1 });
    await web.jobs.enqueue(work, { n: -1 });
    await Promise.all([worker.jobs.runDue(), other.jobs.runDue()]);
    assert.deepEqual(ran.sort(), ["-1:1", "1:1"], "each job claimed by one instance");
    assert.equal((await web.jobs.get(queued.id))?.status, "done");
    // The retry is due after its backoff; claim it directly by running due jobs with a later clock.
    await worker.jobs.runDue({ now: new Date(Date.now() + 10 * 60_000) });
    assert.ok(ran.includes("-1:2"), `retried, ran ${ran}`);
  });

  test("events reach every subscribed service through Redis Streams", async () => {
    const paid = event(`${run}.order.paid`, { payload: t.object({ orderId: t.string() }) });
    const got: string[] = [];
    const receipt = on(paid, job(`io-receipt-${run}`, { input: paid.payload }).handle(({ input }) => void got.push(input.orderId)));
    const billing = createApp({ name: `billing-${run}`, redis, jobs: [receipt], events: { transport: "redis" }, logger: quiet });
    await billing.events.receive(); // creates the consumer group
    const shop = createApp({ name: `shop-${run}`, redis, events: { transport: "redis" }, logger: quiet });
    await shop.events.publish(paid, { orderId: "o-1" });
    await shop.events.publish(paid, { orderId: "o-2" });
    assert.equal(await billing.events.receive(), 2);
    await billing.jobs.runDue();
    assert.deepEqual(got.sort(), ["o-1", "o-2"]);
    assert.equal(await billing.events.receive(), 0, "acknowledged");
  });

  describe("WebSocket broadcasts across instances", () => {
    const watch = route.ws("/watch", { auth: "public", message: t.object({ room: t.string() }) }).handle(({ message, socket }) => {
      socket.join(message.room);
      return { ok: message.room };
    });
    const duplicate = () => {
      const second = connection.duplicate();
      connections.push(second);
      return second;
    };
    const make = () => createApp({ name: `ws-${run}`, db: memory(), routes: [watch], redis, sockets: { transport: "redis", subscriber: ioredisSubscriber(duplicate()) }, logger: quiet });
    let a: ReturnType<typeof make>;
    let b: ReturnType<typeof make>;
    let port: number;
    before(async () => {
      [a, b] = [make(), make()];
      port = (await b.listen(0, "127.0.0.1")).port;
    });
    after(async () => {
      await Promise.all([a.close({ timeoutMs: 1000 }), b.close({ timeoutMs: 1000 })]);
    });

    test("a broadcast on one instance reaches the sockets of another", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/watch`);
      const messages: unknown[] = [];
      const next = () => new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no message, got ${JSON.stringify(messages)}`)), 3000);
        ws.addEventListener("message", (e) => { clearTimeout(timer); const data = JSON.parse(String(e.data)); messages.push(data); resolve(data); }, { once: true });
      });
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const joined = next();
      ws.send(JSON.stringify({ room: "board" }));
      assert.deepEqual(await joined, { ok: "board" });
      // The subscription starts with the first connection; give Redis a moment to confirm it.
      await new Promise((r) => setTimeout(r, 100));
      const note = next();
      await a.sockets.broadcast("board", { text: "from a" });
      assert.deepEqual(await note, { text: "from a" });
      ws.close();
    });
  });
});
