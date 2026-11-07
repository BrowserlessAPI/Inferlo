// Events between services over NATS JetStream (@browserlessapi/inferlo/nats), against a real nats-server with
// JetStream when INFERLO_TEST_NATS_URL is set (CI runs the oldest supported and the latest server and client).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createApp, event, InferloError, job, on, t, type EventMessage } from "../src/index.ts";
import { natsEventTransport } from "../src/nats.ts";

const NATS_URL = process.env.INFERLO_TEST_NATS_URL;
const quiet = { info() {}, error() {} };
const run = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

describe("natsEventTransport() arguments", () => {
  const fake = { publish() {}, request() {} } as never;
  test("checks the connection and options (IL6051)", () => {
    assert.throws(() => natsEventTransport(undefined as never, { service: "billing" }), isCode("IL6051"));
    assert.throws(() => natsEventTransport({} as never, { service: "billing" }), isCode("IL6051"));
    for (const options of [undefined, {}, { service: "" }, { service: "bill ing" }, { service: "a.b" }, { service: "billing", stream: "a.b" }, { service: "billing", staleAfterMs: 10 }, { service: "billing", batch: 0 }, { service: "billing", maxAgeMs: 1.5 }, { service: "billing", group: "x" }]) {
      assert.throws(() => natsEventTransport(fake, options as never), isCode("IL6051"), JSON.stringify(options));
    }
    const transport = natsEventTransport(fake, { service: "billing" });
    assert.equal(transport.name, "nats");
    const app = createApp({ name: "billing", events: { transport }, logger: quiet });
    assert.equal(app.events.transport, "nats");
    assert.equal(app.describe().eventTransport, "nats");
  });
});

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(NATS_URL ? describe : describe.skip)("NATS JetStream event transport", () => {
  const connection = NATS_URL ? connect({ servers: NATS_URL }) : undefined;
  const paid = event(`${run}.order.paid`, { payload: t.object({ orderId: t.string(), amount: t.int() }) });

  function service(name: string, nc: Awaited<NonNullable<typeof connection>>, staleAfterMs?: number) {
    const runs: { input: unknown; id: string; tenantId?: string }[] = [];
    const handle = job(`handle-${name}`, { input: paid.payload }).handle(({ input, id, tenantId }) => void runs.push({ input, id, ...(tenantId ? { tenantId } : {}) }));
    const transport = natsEventTransport(nc, { service: name, ...(staleAfterMs ? { staleAfterMs } : {}) });
    const app = createApp({ name, jobs: [on(paid, handle)], events: { transport }, logger: quiet });
    return { app, runs, transport };
  }

  after(async () => {
    const nc = await connection!;
    const jsm = await jetstreamManager(nc);
    for await (const info of jsm.consumers.list("INFERLO_EVENTS")) {
      if (info.name.includes(run)) await jsm.consumers.delete("INFERLO_EVENTS", info.name).catch(() => false);
    }
    await nc.close();
  });

  test("every subscribed service gets each event once, and instances of one service share it", async () => {
    const nc = await connection!;
    const billing = [service(`billing-${run}`, nc), service(`billing-${run}`, nc)];
    const mail = service(`mail-${run}`, nc);
    for (const s of [...billing, mail]) assert.equal(await s.app.events.receive(), 0); // creates the consumers
    const shop = createApp({ name: `shop-${run}`, events: { transport: natsEventTransport(nc, { service: `shop-${run}` }) }, logger: quiet });
    const published = await Promise.all([1, 2, 3, 4].map((n) => shop.events.publish(paid, { orderId: `o-${n}`, amount: n })));

    const received = await Promise.all(billing.map((s) => s.app.events.receive()));
    assert.equal(received[0]! + received[1]!, 4, `split ${received}`);
    assert.equal(await mail.app.events.receive(), 4);
    for (const s of [...billing, mail]) await s.app.jobs.runDue();
    assert.deepEqual(billing.flatMap((s) => s.runs.map((r) => (r.input as { orderId: string }).orderId)).sort(), ["o-1", "o-2", "o-3", "o-4"]);
    assert.deepEqual(mail.runs.map((r) => (r.input as { orderId: string }).orderId).sort(), ["o-1", "o-2", "o-3", "o-4"]);
    assert.equal(published.length, 4);
    for (const s of [...billing, mail]) assert.equal(await s.app.events.receive(), 0, "all acknowledged");
  });

  test("a delivery that fails, or an instance that stops, gets the event again after staleAfterMs", async () => {
    const nc = await connection!;
    const name = `stale-${run}`;
    const a = natsEventTransport(nc, { service: name, staleAfterMs: 1000 });
    const b = natsEventTransport(nc, { service: name, staleAfterMs: 1000 });
    await a.receive([paid.name], async () => {});
    const trace = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "k=v" };
    await a.send({ id: `evt-stale-${run}`, name: paid.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    await assert.rejects(a.receive([paid.name], async () => Promise.reject(new Error("crashed"))), /crashed/);
    const got: EventMessage[] = [];
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 1);
    assert.deepEqual(got[0], { id: `evt-stale-${run}`, name: paid.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 0, "acknowledged");
  });

  test("publishing one event id twice is delivered once (JetStream's duplicate window)", async () => {
    const nc = await connection!;
    const s = service(`dedupe-${run}`, nc);
    await s.app.events.receive();
    const message = { id: `evt-dup-${run}`, name: paid.name, payload: { orderId: "o-1", amount: 1 }, publishedAt: new Date() };
    await s.transport.send(message);
    await s.transport.send(message);
    assert.equal(await s.app.events.receive(), 1);
    await s.app.jobs.runDue();
    assert.equal(s.runs.length, 1);
  });

  test("a service that subscribes to another event gets it from then on; others' events are not delivered", async () => {
    const nc = await connection!;
    const name = `filter-${run}`;
    const tr = natsEventTransport(nc, { service: name });
    const shipped = `${run}.order.shipped`;
    const got: string[] = [];
    await tr.receive([paid.name], async () => {});
    await tr.send({ id: `s1-${run}`, name: shipped, payload: 1, publishedAt: new Date() });
    assert.equal(await tr.receive([paid.name], async (m) => void got.push(m.id)), 0, "not subscribed to shipped");
    await tr.receive([paid.name, shipped], async (m) => void got.push(m.id));
    await tr.send({ id: `s2-${run}`, name: shipped, payload: 2, publishedAt: new Date() });
    await tr.receive([paid.name, shipped], async (m) => void got.push(m.id));
    assert.ok(got.includes(`s2-${run}`));
    assert.ok(!got.includes(`s1-${run}`), "events from before the subscription are not delivered");
  });

  test("a deleted consumer is created again", async () => {
    const nc = await connection!;
    const name = `deleted-${run}`;
    const tr = natsEventTransport(nc, { service: name });
    await tr.receive([paid.name], async () => {});
    await (await jetstreamManager(nc)).consumers.delete("INFERLO_EVENTS", `inferlo-${name}-${paid.name.replaceAll(".", "_")}`);
    await assert.rejects(tr.receive([paid.name], async () => {}));
    assert.equal(await tr.receive([paid.name], async () => {}), 0);
    await tr.send({ id: `again-${run}`, name: paid.name, payload: { orderId: "x", amount: 1 }, publishedAt: new Date() });
    assert.equal(await tr.receive([paid.name], async () => {}), 1);
  });
});
