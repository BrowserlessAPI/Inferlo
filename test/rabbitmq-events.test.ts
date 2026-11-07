// Events between services over RabbitMQ (@browserlessapi/inferlo/rabbitmq), against a real RabbitMQ when
// INFERLO_TEST_RABBITMQ_URL is set (CI runs the oldest supported and the latest server and amqplib).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, event, InferloError, job, on, t, type EventMessage } from "../src/index.ts";
import { rabbitmqEventTransport, type AmqpChannel, type AmqpConnection } from "../src/rabbitmq.ts";

const RABBITMQ_URL = process.env.INFERLO_TEST_RABBITMQ_URL;
const quiet = { info() {}, error() {} };
const run = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

// amqplib 0.10 has no bundled types; the test needs connect() and a few channel methods only.
type Connection = AmqpConnection & { close(): Promise<void> };
type AdminChannel = AmqpChannel & { deleteQueue(queue: string): Promise<unknown>; publish(exchange: string, key: string, content: Uint8Array): boolean };
const amqp = RABBITMQ_URL ? ((await import("amqplib" as string)) as { connect(url: string): Promise<Connection>; default?: { connect(url: string): Promise<Connection> } }) : undefined;
const connect = (url: string) => (amqp!.connect ?? amqp!.default!.connect)(url);

describe("rabbitmqEventTransport() arguments", () => {
  const fake = { createChannel() {}, createConfirmChannel() {} } as never;
  test("checks the connection and options (IL6054)", () => {
    assert.throws(() => rabbitmqEventTransport(undefined as never, { service: "billing" }), isCode("IL6054"));
    assert.throws(() => rabbitmqEventTransport({ createChannel() {} } as never, { service: "billing" }), isCode("IL6054"));
    for (const options of [undefined, {}, { service: "" }, { service: "bill ing" }, { service: "a.b" }, { service: "billing", exchange: "amq.topic" }, { service: "billing", exchange: "a b" }, { service: "billing", queueType: "stream" }, { service: "billing", staleAfterMs: 10 }, { service: "billing", batch: 0 }, { service: "billing", batch: 1.5 }, { service: "billing", group: "x" }]) {
      assert.throws(() => rabbitmqEventTransport(fake, options as never), isCode("IL6054"), JSON.stringify(options));
    }
    const transport = rabbitmqEventTransport(fake, { service: "billing" });
    assert.equal(transport.name, "rabbitmq");
    const app = createApp({ name: "billing", events: { transport }, logger: quiet });
    assert.equal(app.events.transport, "rabbitmq");
    assert.equal(app.describe().eventTransport, "rabbitmq");
  });
});

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(RABBITMQ_URL ? describe : describe.skip)("RabbitMQ event transport", () => {
  const connections: Connection[] = [];
  const open = async () => {
    const c = await connect(RABBITMQ_URL!);
    connections.push(c);
    return c;
  };
  const paid = event(`${run}.order.paid`, { payload: t.object({ orderId: t.string(), amount: t.int() }) });
  const queues: string[] = [];

  function service(name: string, connection: AmqpConnection, extra: { staleAfterMs?: number; queueType?: "quorum" | "classic" } = {}) {
    const runs: { input: unknown; id: string; tenantId?: string }[] = [];
    const handle = job(`handle-${name}`, { input: paid.payload }).handle(({ input, id, tenantId }) => void runs.push({ input, id, ...(tenantId ? { tenantId } : {}) }));
    const transport = rabbitmqEventTransport(connection, { service: name, ...extra });
    queues.push(`inferlo.${name}.${paid.name}`);
    const app = createApp({ name, jobs: [on(paid, handle)], events: { transport }, logger: quiet });
    return { app, runs, transport };
  }

  after(async () => {
    if (connections.length) {
      const admin = (await connections[0]!.createChannel()) as AdminChannel;
      for (const queue of queues) await admin.deleteQueue(queue).catch(() => false);
      await admin.close().catch(() => {});
    }
    for (const c of connections) await c.close().catch(() => {});
  });

  test("every subscribed service gets each event once, and instances of one service share it", async () => {
    const [one, two] = [await open(), await open()];
    const billing = [service(`billing-${run}`, one), service(`billing-${run}`, two)];
    const mail = service(`mail-${run}`, one, { queueType: "classic" });
    for (const s of [...billing, mail]) assert.equal(await s.app.events.receive(), 0); // declares and binds the queues
    const shop = createApp({ name: `shop-${run}`, events: { transport: rabbitmqEventTransport(two, { service: `shop-${run}` }) }, logger: quiet });
    await Promise.all([1, 2, 3, 4].map((n) => shop.events.publish(paid, { orderId: `o-${n}`, amount: n })));

    const received = [await billing[0]!.app.events.receive(), await billing[1]!.app.events.receive()];
    assert.equal(received[0]! + received[1]!, 4, `split ${received}`);
    assert.equal(await mail.app.events.receive(), 4);
    for (const s of [...billing, mail]) await s.app.jobs.runDue();
    assert.deepEqual(billing.flatMap((s) => s.runs.map((r) => (r.input as { orderId: string }).orderId)).sort(), ["o-1", "o-2", "o-3", "o-4"]);
    assert.deepEqual(mail.runs.map((r) => (r.input as { orderId: string }).orderId).sort(), ["o-1", "o-2", "o-3", "o-4"]);
    for (const s of [...billing, mail]) assert.equal(await s.app.events.receive(), 0, "all acknowledged");
  });

  test("a delivery that fails gets the event again after staleAfterMs, with its trace and tenant", async () => {
    const connection = await open();
    const name = `stale-${run}`;
    queues.push(`inferlo.${name}.${paid.name}`);
    const a = rabbitmqEventTransport(connection, { service: name, staleAfterMs: 1000 });
    const b = rabbitmqEventTransport(await open(), { service: name, staleAfterMs: 1000 });
    await a.receive([paid.name], async () => {});
    const trace = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "k=v" };
    await a.send({ id: `evt-stale-${run}`, name: paid.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    await assert.rejects(a.receive([paid.name], async () => Promise.reject(new Error("crashed"))), /crashed/);
    const got: EventMessage[] = [];
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 0, "held until staleAfterMs");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 1);
    assert.deepEqual(got[0], { id: `evt-stale-${run}`, name: paid.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m)), 0, "acknowledged");
  });

  test("the events an instance read but did not acknowledge are delivered again when its connection closes", async () => {
    const name = `stopped-${run}`;
    queues.push(`inferlo.${name}.${paid.name}`);
    const doomed = await connect(RABBITMQ_URL!);
    const a = rabbitmqEventTransport(doomed, { service: name, staleAfterMs: 3_600_000 });
    await a.receive([paid.name], async () => {});
    await a.send({ id: `evt-stop-${run}`, name: paid.name, payload: { orderId: "o-1", amount: 1 }, publishedAt: new Date() });
    await assert.rejects(a.receive([paid.name], async () => Promise.reject(new Error("stopping"))));
    await doomed.close();
    const b = rabbitmqEventTransport(await open(), { service: name });
    const got: string[] = [];
    assert.equal(await b.receive([paid.name], async (m) => void got.push(m.id)), 1);
    assert.deepEqual(got, [`evt-stop-${run}`]);
  });

  test("a service gets an event from its first read on; others' events are not delivered; foreign messages are dropped", async () => {
    const connection = await open();
    const name = `filter-${run}`;
    const shipped = `${run}.order.shipped`;
    queues.push(`inferlo.${name}.${paid.name}`, `inferlo.${name}.${shipped}`);
    const tr = rabbitmqEventTransport(connection, { service: name });
    const got: string[] = [];
    await tr.receive([paid.name], async () => {});
    await tr.send({ id: `s1-${run}`, name: shipped, payload: 1, publishedAt: new Date() });
    assert.equal(await tr.receive([paid.name], async (m) => void got.push(m.id)), 0, "not subscribed to shipped");
    await tr.receive([paid.name, shipped], async (m) => void got.push(m.id));
    await tr.send({ id: `s2-${run}`, name: shipped, payload: 2, publishedAt: new Date() });
    const raw = (await connection.createChannel()) as AdminChannel;
    raw.publish("inferlo.events", paid.name, Buffer.from("not json"));
    await raw.close();
    await new Promise((r) => setTimeout(r, 100));
    await tr.receive([paid.name, shipped], async (m) => void got.push(m.id));
    assert.deepEqual(got, [`s2-${run}`], "events from before the subscription are not delivered");
    assert.equal(await tr.receive([paid.name, shipped], async (m) => void got.push(m.id)), 0, "the foreign message was dropped");
  });

  test("a deleted queue is declared again", async () => {
    const connection = await open();
    const name = `deleted-${run}`;
    queues.push(`inferlo.${name}.${paid.name}`);
    const tr = rabbitmqEventTransport(connection, { service: name });
    await tr.receive([paid.name], async () => {});
    const admin = (await connection.createChannel()) as AdminChannel;
    await admin.deleteQueue(`inferlo.${name}.${paid.name}`);
    await admin.close();
    await assert.rejects(tr.receive([paid.name], async () => {}));
    assert.equal(await tr.receive([paid.name], async () => {}), 0);
    await tr.send({ id: `again-${run}`, name: paid.name, payload: { orderId: "x", amount: 1 }, publishedAt: new Date() });
    assert.equal(await tr.receive([paid.name], async () => {}), 1);
  });
});
