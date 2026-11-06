import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createClient } from "redis";
import { createApp, event, InferloError, job, on, t, type EventMessage, type EventTransport, type RedisClient } from "../src/index.ts";
import { redisEventTransport } from "../src/redis-events.ts";

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };
const run = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A broker in memory: one queue per (group, event name), like a consumer group per service. */
function memoryBroker() {
  const sent: EventMessage[] = [];
  const queues = new Map<string, EventMessage[]>();
  const groups = new Set<string>();
  const transport = (group: string): EventTransport => ({
    name: "memory-broker",
    async send(message) {
      sent.push(message);
      for (const g of groups) for (const key of queues.keys()) if (key === `${g}\u0000${message.name}`) queues.get(key)!.push(message);
    },
    async receive(names, deliver) {
      groups.add(group);
      let delivered = 0;
      for (const name of names) {
        const key = `${group}\u0000${name}`;
        if (!queues.has(key)) queues.set(key, []);
        const queue = queues.get(key)!;
        while (queue.length) {
          await deliver(queue[0]!); // a rejected delivery stays queued
          queue.shift();
          delivered++;
        }
      }
      return delivered;
    },
  });
  return { sent, transport };
}

const orderPaid = event("order.paid", { payload: t.object({ orderId: t.string(), amount: t.int().min(0) }) });

function service(name: string, transport: EventTransport | "redis", redis?: RedisClient, paid = orderPaid) {
  const runs: { input: unknown; id: string }[] = [];
  const handle = job(`handle-${name}`, { input: paid.payload }).handle(({ input, id }) => void runs.push({ input, id }));
  const errors: { message: string; data: unknown }[] = [];
  const logger = { info() {}, error: (message: string, data: unknown) => void errors.push({ message, data }) };
  const app = createApp({ name, ...(redis ? { redis } : {}), jobs: [on(paid, handle)], events: { transport }, logger });
  return { app, runs, errors };
}

describe("createApp({ events: { transport } })", () => {
  test("invalid options raise IL6033, the redis transport needs redis (IL6031) and a name (IL6033)", () => {
    const code = (c: string, fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === c && pattern.test(e.message));
    code("IL6033", () => createApp({ events: { transport: "kafka" as never } }), /"kafka"/);
    code("IL6033", () => createApp({ events: { transport: { name: "x" } as never } }), /send\(message\)/);
    code("IL6033", () => createApp({ events: { transprt: "redis" } as never }), /Unknown events option "transprt"/);
    code("IL6031", () => createApp({ name: "shop", events: { transport: "redis" } }), /events transport "redis"/);
    const redis: RedisClient = { sendCommand: async () => null };
    code("IL6033", () => createApp({ redis, events: { transport: "redis" } }), /createApp\(\{ name \}\)/);
    const app = createApp({ name: "shop", redis, events: { transport: "redis" } });
    assert.equal(app.events.transport, "redis");
    assert.equal(app.describe().eventTransport, "redis");
    assert.equal(createApp({}).events.transport, undefined);
    assert.equal("eventTransport" in createApp({}).describe(), false);
  });

  test("published events go through the transport; each subscribed service queues its jobs when it receives them", async () => {
    const broker = memoryBroker();
    const shop = createApp({ name: "shop", events: { transport: broker.transport("shop") }, logger: quiet });
    const billing = service("billing", broker.transport("billing"));
    const mail = service("mail", broker.transport("mail"));
    // Each service starts reading (app.jobs.start() does this on every poll) before the events are published.
    assert.equal(await billing.app.events.receive(), 0);
    assert.equal(await mail.app.events.receive(), 0);

    const published = await shop.events.publish(orderPaid, { orderId: "o-1", amount: 25 });
    assert.deepEqual(published.jobs, [], "the shop has no subscriptions");
    assert.equal(broker.sent.length, 1);
    assert.deepEqual({ ...broker.sent[0], publishedAt: undefined }, { id: published.id, name: "order.paid", payload: { orderId: "o-1", amount: 25 }, publishedAt: undefined });
    assert.deepEqual(await shop.jobs.runDue(), { done: 0, retried: 0, failed: 0 });

    assert.equal(await billing.app.events.receive(), 1);
    assert.equal(await mail.app.events.receive(), 1);
    assert.deepEqual(await billing.app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.deepEqual(await mail.app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.deepEqual(billing.runs.map((r) => r.input), [{ orderId: "o-1", amount: 25 }]);
    assert.deepEqual(mail.runs.map((r) => r.input), [{ orderId: "o-1", amount: 25 }]);
  });

  test("a publishing service with its own subscription gets the job when it receives the event, with the id publish returned", async () => {
    const broker = memoryBroker();
    const billing = service("billing", broker.transport("billing"));
    await billing.app.events.receive();
    const published = await billing.app.events.publish(orderPaid, { orderId: "o-2", amount: 5 });
    assert.equal(published.jobs.length, 1);
    assert.deepEqual(await billing.app.jobs.runDue(), { done: 0, retried: 0, failed: 0 }, "nothing is queued before the event is received");
    await billing.app.events.receive();
    await billing.app.jobs.runDue();
    assert.deepEqual(billing.runs.map((r) => r.id), published.jobs);
  });

  test("an event delivered twice queues its jobs once", async () => {
    const message: EventMessage = { id: "evt-1", name: "order.paid", payload: { orderId: "o-3", amount: 1 }, publishedAt: new Date() };
    const twice: EventTransport = {
      name: "twice",
      send: async () => {},
      async receive(_names, deliver) {
        await deliver(message);
        await deliver(message);
        return 2;
      },
    };
    const handle = job("handle-twice", { input: orderPaid.payload }).handle(() => {});
    const app = createApp({ name: "billing", jobs: [on(orderPaid, handle)], events: { transport: twice }, logger: quiet });
    assert.equal(await app.events.receive(), 2);
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
  });

  test("a received payload that does not match is dropped and logged with IL6034, without the payload", async () => {
    const broker = memoryBroker();
    const billing = service("billing", broker.transport("billing"));
    await billing.app.events.receive();
    const older = event("order.paid", { payload: t.object({ orderId: t.string(), amount: t.string() }) });
    const shop = createApp({ name: "shop", events: { transport: broker.transport("shop") }, logger: quiet });
    await shop.events.publish(older, { orderId: "secret-order", amount: "lots" });
    assert.equal(await billing.app.events.receive(), 1, "acknowledged: delivering it again cannot help");
    assert.equal(await billing.app.events.receive(), 0);
    assert.deepEqual(await billing.app.jobs.runDue(), { done: 0, retried: 0, failed: 0 });
    assert.equal(billing.errors.length, 1);
    const error = billing.errors[0]!.data as InferloError;
    assert.equal(error.code, "IL6034");
    assert.match(error.message, /amount/);
    assert.doesNotMatch(error.message, /secret-order|lots/);
  });

  test("the payload is validated before it is sent", async () => {
    const broker = memoryBroker();
    const shop = createApp({ name: "shop", events: { transport: broker.transport("shop") }, logger: quiet });
    await assert.rejects(shop.events.publish(orderPaid, { orderId: "o", amount: -1 }), /amount/);
    assert.equal(broker.sent.length, 0);
  });

  test("app.jobs.start() receives events on every poll, and a failing receive does not stop the jobs", async () => {
    const broker = memoryBroker();
    const billing = service("billing", broker.transport("billing"));
    const shop = createApp({ name: "shop", events: { transport: broker.transport("shop") }, logger: quiet });
    await billing.app.events.receive();
    const worker = billing.app.jobs.start({ pollMs: 10 });
    await shop.events.publish(orderPaid, { orderId: "o-4", amount: 3 });
    for (let i = 0; i < 100 && !billing.runs.length; i++) await new Promise((r) => setTimeout(r, 10));
    await worker.stop();
    assert.equal(billing.runs.length, 1);

    let runs = 0;
    const broken: EventTransport = { name: "broken", send: async () => {}, receive: async () => Promise.reject(new Error("broker down")) };
    const errors: string[] = [];
    const app = createApp({ name: "b", jobs: [on(orderPaid, job("count", { input: orderPaid.payload }).handle(() => void runs++))], events: { transport: broken }, logger: { info() {}, error: (m: string) => void errors.push(m) } });
    await app.jobs.enqueue(app.jobs.list[0]!, { orderId: "x", amount: 1 });
    const w = app.jobs.start({ pollMs: 10 });
    for (let i = 0; i < 100 && !runs; i++) await new Promise((r) => setTimeout(r, 10));
    await w.stop();
    assert.equal(runs, 1);
    assert.ok(errors.includes("event receive error"));
  });
});

// Runs against a real Redis when INFERLO_TEST_REDIS_URL is set (describe.skip, because Bun 1.3.0 ignores { skip } on describe).
(REDIS_URL ? describe : describe.skip)("Redis Streams event transport", () => {
  const connected = REDIS_URL ? createClient({ url: REDIS_URL }).connect() : undefined;
  const redis: RedisClient = { sendCommand: async (args) => (await connected!).sendCommand(args) };
  const paid = event(`${run}.order.paid`, { payload: t.object({ orderId: t.string(), amount: t.int() }) });
  const stream = `inferlo:events:${run}.order.paid`;
  after(async () => {
    const client = await connected;
    for (const key of await client!.keys(`inferlo:events:${run}.*`)) await client!.del(key);
    await client?.close();
  });

  test("every subscribed service gets each event once, and instances of one service share it", async () => {
    const billing = [service(`billing-${run}`, "redis", redis, paid), service(`billing-${run}`, "redis", redis, paid)];
    const mail = service(`mail-${run}`, "redis", redis, paid);
    for (const s of [...billing, mail]) await s.app.events.receive(); // creates the consumer groups
    const shop = createApp({ name: `shop-${run}`, redis, events: { transport: "redis" }, logger: quiet });
    const published = await Promise.all([1, 2, 3, 4].map((n) => shop.events.publish(paid, { orderId: `o-${n}`, amount: n })));

    const received = await Promise.all(billing.map((s) => s.app.events.receive()));
    assert.equal(received[0]! + received[1]!, 4, `split ${received}`);
    assert.equal(await mail.app.events.receive(), 4);
    for (const s of [...billing, mail]) await s.app.jobs.runDue();
    assert.deepEqual(billing.flatMap((s) => s.runs.map((r) => (r.input as { orderId: string }).orderId)).sort(), ["o-1", "o-2", "o-3", "o-4"]);
    assert.deepEqual(mail.runs.map((r) => (r.input as { orderId: string }).orderId).sort(), ["o-1", "o-2", "o-3", "o-4"]);

    // Each entry carries the event id, and every entry was acknowledged by both groups.
    const client = (await connected)!;
    const entries = await client.xRange(stream, "-", "+");
    assert.deepEqual(entries!.map((e) => e.message.id).sort(), published.map((p) => p.id).sort());
    const groups = await client.xInfoGroups(stream);
    for (const g of groups) assert.equal(Number(g.pending), 0, `group ${g.name} has nothing pending`);
  });

  test("an event read by an instance that stopped before acknowledging it is delivered to another one", async () => {
    const group = `stale-${run}`;
    const a = redisEventTransport(redis, { group, staleAfterMs: 200 });
    const b = redisEventTransport(redis, { group, staleAfterMs: 200 });
    await a.receive([paid.name], async () => {});
    await a.send({ id: "evt-stale", name: paid.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date(), trace: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "k=v" } });
    await assert.rejects(a.receive([paid.name], async () => Promise.reject(new Error("crashed"))), /crashed/);
    const got: EventMessage[] = [];
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 0, "not stale yet");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 1);
    assert.equal(got[0]!.id, "evt-stale");
    assert.deepEqual(got[0]!.payload, { orderId: "o-9", amount: 9 });
    assert.deepEqual(got[0]!.trace, { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "k=v" });
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 0, "acknowledged");
  });

  test("streams are trimmed to about maxLength entries", async () => {
    const name = `${run}.trim`;
    const tr = redisEventTransport(redis, { group: `trim-${run}`, maxLength: 10 });
    for (let i = 0; i < 300; i++) await tr.send({ id: `e${i}`, name, payload: i, publishedAt: new Date() });
    const length = await (await connected)!.xLen(`inferlo:events:${name}`);
    assert.ok(length < 300 && length >= 10, `length ${length}`);
  });

  test("a deleted stream and group are created again", async () => {
    const name = `${run}.flushed`;
    const tr = redisEventTransport(redis, { group: `flush-${run}` });
    await tr.receive([name], async () => {});
    await (await connected)!.del(`inferlo:events:${name}`);
    await assert.rejects(tr.receive([name], async () => {}), /NOGROUP/);
    assert.equal(await tr.receive([name], async () => {}), 0);
    await tr.send({ id: "again", name, payload: 1, publishedAt: new Date() });
    assert.equal(await tr.receive([name], async () => {}), 1);
  });
});
