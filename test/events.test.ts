import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, event, InferloError, isEvent, job, memory, module, on, route, t, ValidationError, type EventPayload } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

const quiet = { info: () => {}, error: () => {} };
const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const orderPaid = event("order.paid", { payload: t.object({ orderId: t.string(), amount: t.int().min(0), currency: t.enum(["EUR", "USD"]).default("EUR") }), summary: "An order was paid." });

function setup(store: "memory" | "database" = "memory", db = memory()) {
  const runs: { job: string; input: unknown; id: string }[] = [];
  const sendReceipt = job(`send-receipt-${suffix}`, { input: orderPaid.payload, retries: 1 }).handle(({ input, id }) => {
    if (input.orderId === "broken") throw new Error("mail server down");
    runs.push({ job: "send-receipt", input, id });
  });
  const addPoints = job(`add-points-${suffix}`, { input: t.object({ orderId: t.string(), amount: t.int() }) }).handle(async ({ input, id, events }) => {
    runs.push({ job: "add-points", input, id });
    if (input.amount >= 1000) await events.publish(bigSpender, { orderId: input.orderId });
  });
  const bigSpender = event("customer.big-spender", { payload: t.object({ orderId: t.string() }) });
  const notifySales = job(`notify-sales-${suffix}`, { input: bigSpender.payload }).handle(({ input, id }) => void runs.push({ job: "notify-sales", input, id }));
  const routes = {
    pay: route.post("/orders/:id/pay", { auth: "public", body: t.object({ amount: t.int() }) }).handle(async ({ params, body, events }) => {
      const published = await events.publish(orderPaid, { orderId: params.id, amount: body.amount });
      return { eventId: published.id, jobs: published.jobs.length };
    }),
  };
  const app = createApp({
    db,
    routes: [routes],
    jobs: [on(orderPaid, sendReceipt), on(orderPaid, addPoints), on(bigSpender, notifySales)],
    jobQueue: { store },
    logger: quiet,
  });
  return { app, runs, sendReceipt, addPoints, notifySales, bigSpender };
}

const pay = (app: ReturnType<typeof setup>["app"], id: string, amount: number | string) =>
  app.fetch(new Request(`http://localhost/orders/${id}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount }) }));

describe("events", () => {
  test("event() and on() define plain values; the jobs of on() are registered with them", () => {
    assert.ok(isEvent(orderPaid));
    assert.equal(orderPaid.name, "order.paid");
    const { app, sendReceipt } = setup();
    assert.ok(app.jobs.list.includes(sendReceipt));
    assert.deepEqual(app.events.list.map((e) => e.name), ["order.paid", "customer.big-spender"]);
    const map = app.describe();
    assert.deepEqual(map.events, [
      { name: "order.paid", summary: "An order was paid.", payload: orderPaid.payload.toJSONSchema(), jobs: [`send-receipt-${suffix}`, `add-points-${suffix}`] },
      { name: "customer.big-spender", payload: t.object({ orderId: t.string() }).toJSONSchema(), jobs: [`notify-sales-${suffix}`] },
    ]);
  });

  test("publishing queues every subscribed job with the validated payload; the jobs run with the job queue", async () => {
    const { app, runs } = setup();
    const res = await pay(app, "o-1", 25);
    assert.equal(res.status, 200);
    const { eventId, jobs } = await res.json();
    assert.equal(jobs, 2);
    assert.match(eventId, /^[0-9a-f-]{36}$/);
    assert.equal(runs.length, 0, "subscribers run in the background, not in the request");
    assert.deepEqual(await app.jobs.runDue(), { done: 2, retried: 0, failed: 0 });
    assert.deepEqual(runs.map((r) => [r.job, r.input]), [
      ["send-receipt", { orderId: "o-1", amount: 25, currency: "EUR" }],
      ["add-points", { orderId: "o-1", amount: 25 }],
    ]);
  });

  test("jobs publish events too, and the follow-up jobs run in the same runDue", async () => {
    const { app, runs } = setup();
    await app.events.publish(orderPaid, { orderId: "o-2", amount: 5000, currency: "USD" });
    assert.deepEqual(await app.jobs.runDue(), { done: 3, retried: 0, failed: 0 });
    assert.deepEqual(runs.map((r) => r.job), ["send-receipt", "add-points", "notify-sales"]);
    assert.deepEqual(runs[2]!.input, { orderId: "o-2" });
  });

  test("the queued jobs have ids derived from the event id, so a repeated delivery is queued once", async () => {
    const { app, sendReceipt } = setup();
    const published = await app.events.publish(orderPaid, { orderId: "o-3", amount: 1 });
    assert.deepEqual(published.name, "order.paid");
    assert.ok(published.publishedAt instanceof Date);
    assert.equal(published.jobs.length, 2);
    const record = await app.jobs.get(published.jobs[0]!);
    assert.equal(record!.name, sendReceipt.name);
    assert.deepEqual(record!.input, { orderId: "o-3", amount: 1, currency: "EUR" });
    const again = await app.events.publish(orderPaid, { orderId: "o-3", amount: 1 }, { id: published.id });
    assert.deepEqual(again.jobs, published.jobs, "the same event id gives the same job ids");
    assert.deepEqual(await app.jobs.runDue(), { done: 2, retried: 0, failed: 0 });
  });

  test("failed subscribers are retried like any job", async () => {
    const { app } = setup();
    await app.events.publish(orderPaid, { orderId: "broken", amount: 1 });
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 1, failed: 0 });
  });

  test("an invalid payload is rejected before anything is queued (422 in a route)", async () => {
    const { app } = setup();
    const res = await pay(app, "o-4", "lots");
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "IL1001");
    await assert.rejects(app.events.publish(orderPaid, { orderId: "o-4", amount: -1 }), (e: unknown) => e instanceof ValidationError);
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 0 });
  });

  test("an event without subscribers in this app is valid and queues nothing", async () => {
    const { app } = setup();
    const shipped = event("order.shipped", { payload: t.object({ orderId: t.string() }) });
    const published = await app.events.publish(shipped, { orderId: "o-5" });
    assert.deepEqual(published.jobs, []);
    await assert.rejects(app.events.publish(shipped, {} as never), (e: unknown) => e instanceof ValidationError);
  });

  test("payload types: publish takes the event's input, on() needs a job that accepts its payload", () => {
    type Payload = EventPayload<typeof orderPaid>;
    const ok: Payload = { orderId: "x", amount: 1 };
    assert.ok(ok);
    const wrongJob = job(`wrong-${suffix}`, { input: t.object({ userId: t.uuid() }) }).handle(() => {});
    // @ts-expect-error the job does not accept the event's payload
    assert.throws(() => on(orderPaid, wrongJob), (e: unknown) => e instanceof InferloError && e.code === "IL6032");
    const app = createApp({ logger: quiet });
    // @ts-expect-error amount is required
    void app.events.publish(orderPaid, { orderId: "x" }).catch(() => {});
  });

  test("subscriptions in modules are registered with the module", () => {
    const handler = job(`module-handler-${suffix}`, { input: orderPaid.payload }).handle(() => {});
    const billing = module("billing", { jobs: [on(orderPaid, handler)] });
    const app = createApp({ modules: [billing], logger: quiet });
    assert.deepEqual(app.describe().events[0]!.jobs, [handler.name]);
    assert.deepEqual(app.describe().modules[0]!.jobs, [handler.name]);
  });

  test("invalid events and subscriptions raise IL6032", () => {
    const fails = (fn: () => unknown, pattern?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL6032" && (!pattern || pattern.test(e.message)));
    for (const name of ["", "Order.Paid", "order..paid", ".order", "order paid", "1order", 5]) fails(() => event(name as never, { payload: t.object({}) }), /name/);
    fails(() => event("order.paid", {} as never), /payload/);
    fails(() => event("order.paid", { payload: t.object({}), retries: 1 } as never), /unknown option/);
    fails(() => on({} as never, job(`x-${suffix}`, { input: t.object({}) }).handle(() => {})), /event/);
    fails(() => on(orderPaid, {} as never), /job/);
    const a = event("order.paid", { payload: t.object({ id: t.string() }) });
    const b = event("order.paid", { payload: t.object({ ref: t.string() }) });
    const j1 = job(`j1-${suffix}`, { input: t.object({ id: t.string() }) }).handle(() => {});
    const j2 = job(`j2-${suffix}`, { input: t.object({ ref: t.string() }) }).handle(() => {});
    fails(() => createApp({ jobs: [on(a, j1), on(b, j2)], logger: quiet }), /Two different events/);
    const twice = on(a, j1);
    fails(() => createApp({ jobs: [twice, on(a, j1)], logger: quiet }), /twice/);
  });

  if (PG_URL) {
    test("with the database queue, published events are queued in Postgres and run by any worker", async () => {
      const db = postgres({ url: PG_URL });
      try {
        const { app, runs } = setup("database", db as never);
        const published = await app.events.publish(orderPaid, { orderId: "pg-1", amount: 10 });
        await app.events.publish(orderPaid, { orderId: "pg-1", amount: 10 }, { id: published.id });
        assert.equal((await app.jobs.get(published.jobs[1]!))!.status, "pending");
        const result = await app.jobs.runDue();
        assert.equal(result.done >= 2, true);
        assert.deepEqual(runs.filter((r) => (r.input as { orderId: string }).orderId === "pg-1").map((r) => r.job), ["send-receipt", "add-points"]);
      } finally {
        await db.close?.();
      }
    });
  }
});
