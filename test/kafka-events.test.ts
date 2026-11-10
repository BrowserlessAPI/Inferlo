// Events between services over Kafka (@browserlessapi/inferlo/kafka), against a real Kafka when
// INFERLO_TEST_KAFKA_BROKERS is set (CI runs the oldest supported and the latest Kafka and @confluentinc/kafka-javascript).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, event, InferloError, job, on, t, type EventMessage } from "../src/index.ts";
import { kafkaEventTransport, type KafkaClient } from "../src/kafka.ts";

const BROKERS = process.env.INFERLO_TEST_KAFKA_BROKERS;
const quiet = { info() {}, error() {} };
const run = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("kafkaEventTransport() arguments", () => {
  const fake = { producer() {}, consumer() {}, admin() {} } as never;
  test("checks the client and options (IL6072)", () => {
    assert.throws(() => kafkaEventTransport(undefined as never, { service: "billing" }), isCode("IL6072"));
    assert.throws(() => kafkaEventTransport({ producer() {}, consumer() {} } as never, { service: "billing" }), isCode("IL6072"));
    for (const options of [undefined, {}, { service: "" }, { service: "bill ing" }, { service: "a.b" }, { service: "billing", topicPrefix: "__x" }, { service: "billing", topicPrefix: "a b" }, { service: "billing", partitions: 0 }, { service: "billing", fromBeginning: "yes" }, { service: "billing", staleAfterMs: 10 }, { service: "billing", batch: 0 }, { service: "billing", batch: 1.5 }, { service: "billing", group: "x" }]) {
      assert.throws(() => kafkaEventTransport(fake, options as never), isCode("IL6072"), JSON.stringify(options));
    }
    const transport = kafkaEventTransport(fake, { service: "billing" });
    assert.equal(transport.name, "kafka");
    const app = createApp({ name: "billing", events: { transport }, logger: quiet });
    assert.equal(app.events.transport, "kafka");
    assert.equal(app.describe().eventTransport, "kafka");
  });

  test("delivers in order, commits after delivery, holds a failed event for staleAfterMs and stops on close (no broker)", async () => {
    // A stand-in client with the KafkaJS API: one topic, one partition, eachMessage awaited like the real consumer.
    const log: string[] = [];
    const topics: Record<string, { value: string; offset: string }[]> = {};
    let eachMessage: ((p: { topic: string; partition: number; message: { value: string; offset: string } }) => Promise<void>) | undefined;
    let pumping: Promise<void> | undefined;
    let stop = false;
    const pump = async () => {
      for (const [topic, messages] of Object.entries(topics)) {
        while (messages.length && !stop) {
          try {
            await eachMessage!({ topic, partition: 0, message: messages[0]! });
            log.push(`commit ${messages.shift()!.offset}`);
          } catch {
            return; // not committed: read again later
          }
        }
      }
    };
    const fake: KafkaClient = {
      admin: () => ({ connect: async () => {}, disconnect: async () => void log.push("admin closed"), createTopics: async ({ topics: list }) => (list.forEach((t) => (topics[t.topic] ??= [])), true) }),
      producer: () => ({
        connect: async () => {},
        disconnect: async () => void log.push("producer closed"),
        send: async ({ topic, messages }) => {
          for (const m of messages) topics[topic]!.push({ value: m.value, offset: String(topics[topic]!.length) });
          pumping ??= pump().finally(() => (pumping = undefined));
        },
      }),
      consumer: (config) => {
        log.push(`consumer ${JSON.stringify(config)}`);
        return {
          connect: async () => {},
          disconnect: async () => {
            stop = true;
            log.push("consumer closed");
          },
          subscribe: async ({ topics: list }) => void log.push(`subscribe ${list.join(",")}`),
          run: async (config) => void (eachMessage = config.eachMessage),
        };
      },
    };
    const transport = kafkaEventTransport(fake, { service: "billing", staleAfterMs: 1000 });
    const got: string[] = [];
    assert.equal(await transport.receive(["order.paid"], async () => {}), 0);
    assert.deepEqual(log.slice(0, 2), ['consumer {"kafkaJS":{"groupId":"inferlo.billing","fromBeginning":false}}', "subscribe inferlo.events.order.paid"]);
    for (const n of [1, 2, 3]) await transport.send({ id: `e${n}`, name: "order.paid", payload: { n }, publishedAt: new Date() });
    await sleep(10);
    await assert.rejects(transport.receive(["order.paid"], async () => Promise.reject(new Error("down"))), /down/);
    assert.equal(await transport.receive(["order.paid"], async (m) => void got.push(m.id)), 0, "held until staleAfterMs");
    await sleep(1100);
    assert.equal(await transport.receive(["order.paid"], async (m) => void got.push(m.id)), 3);
    assert.deepEqual(got, ["e1", "e2", "e3"], "in order, the failed one first");
    assert.deepEqual(log.filter((l) => l.startsWith("commit")), ["commit 0", "commit 1", "commit 2"]);
    await transport.send({ id: "e4", name: "order.paid", payload: {}, publishedAt: new Date() });
    await sleep(10);
    await transport.close();
    assert.ok(!log.includes("commit 3"), "an event not delivered before close is not committed");
    assert.ok(log.includes("consumer closed") && log.includes("producer closed") && log.includes("admin closed"));
    await assert.rejects(transport.send({ id: "e5", name: "order.paid", payload: {}, publishedAt: new Date() }), /closed/);
    assert.equal(await transport.receive(["order.paid"], async () => {}), 0);
  });
});

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(BROKERS ? describe : describe.skip)("Kafka event transport", () => {
  type Kafka = KafkaClient;
  const transports: { close(): Promise<void> }[] = [];
  const apps: { close(): Promise<void> }[] = [];
  type KafkaModule = { KafkaJS: { Kafka: new (config: object) => Kafka; logLevel: { NOTHING: number } } };
  let kafkaModule: KafkaModule | undefined;
  const client = async () => {
    if (!kafkaModule) {
      const loaded = (await import("@confluentinc/kafka-javascript" as string)) as Partial<KafkaModule> & { default?: KafkaModule };
      kafkaModule = loaded.KafkaJS ? (loaded as KafkaModule) : loaded.default!;
    }
    return new kafkaModule.KafkaJS.Kafka({ kafkaJS: { brokers: BROKERS!.split(","), logLevel: kafkaModule.KafkaJS.logLevel.NOTHING } });
  };
  const paid = event(`${run}.order.paid`, { payload: t.object({ orderId: t.string(), amount: t.int() }) });
  const track = <T extends { close(): Promise<void> }>(x: T) => (transports.push(x), x);

  /** Calls receive() until it returned count events in total (the consumer joins its group first), or 30 s passed. */
  async function receiveAll(receive: () => Promise<number>, count: number, ms = 30_000) {
    let total = 0;
    const until = Date.now() + ms;
    while (total < count && Date.now() < until) {
      total += await receive();
      if (total < count) await sleep(100);
    }
    return total;
  }

  // Each test has its own event, so its topic holds only that test's events.
  const stale = event(`${run}.order.retried`, { payload: paid.payload });
  const stopped = event(`${run}.order.stopped`, { payload: paid.payload });

  function service(name: string, kafka: Kafka, extra: { staleAfterMs?: number } = {}, ev = paid) {
    const runs: { input: unknown; id: string }[] = [];
    const handle = job(`handle-${name}`, { input: ev.payload }).handle(({ input, id }) => void runs.push({ input, id }));
    const transport = kafkaEventTransport(kafka, { service: name, fromBeginning: true, partitions: 2, ...extra });
    const app = createApp({ name, jobs: [on(ev, handle)], events: { transport }, logger: quiet });
    apps.push(app);
    return { app, runs, transport };
  }

  after(async () => {
    for (const app of apps) await app.close().catch(() => {});
    for (const tr of transports) await tr.close().catch(() => {});
  });

  test("every subscribed service gets each event once, and instances of one service share it", { timeout: 90_000 }, async () => {
    const billing = [service(`billing-${run}`, await client()), service(`billing-${run}`, await client())];
    const mail = service(`mail-${run}`, await client());
    const shop = createApp({ name: `shop-${run}`, events: { transport: track(kafkaEventTransport(await client(), { service: `shop-${run}`, partitions: 2 })) }, logger: quiet });
    apps.push(shop);
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => shop.events.publish(paid, { orderId: `o-${n}`, amount: n })));

    // Both billing instances join the group before reading, so the partitions are shared between them.
    await Promise.all(billing.map((s) => s.app.events.receive()));
    const both = await receiveAll(async () => (await billing[0]!.app.events.receive()) + (await billing[1]!.app.events.receive()), 6);
    assert.equal(both, 6);
    assert.equal(await receiveAll(() => mail.app.events.receive(), 6), 6);
    for (const s of [...billing, mail]) await s.app.jobs.runDue();
    assert.deepEqual(billing.flatMap((s) => s.runs.map((r) => (r.input as { orderId: string }).orderId)).sort(), ["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
    assert.deepEqual(mail.runs.map((r) => (r.input as { orderId: string }).orderId).sort(), ["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
    await sleep(500);
    for (const s of [...billing, mail]) assert.equal(await s.app.events.receive(), 0, "nothing delivered twice");
  });

  test("a delivery that fails gets the event again after staleAfterMs, with its trace and tenant", { timeout: 90_000 }, async () => {
    const tr = track(kafkaEventTransport(await client(), { service: `stale-${run}`, fromBeginning: true, staleAfterMs: 1000 }));
    const trace = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "k=v" };
    await tr.send({ id: `evt-stale-${run}`, name: stale.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    let failures = 0;
    const until = Date.now() + 30_000;
    while (!failures && Date.now() < until) {
      await tr.receive([stale.name], async () => Promise.reject(new Error("crashed"))).catch(() => failures++);
      await sleep(100);
    }
    assert.equal(failures, 1);
    const got: EventMessage[] = [];
    assert.equal(await tr.receive([stale.name], async (m) => void got.push(m)), 0, "held until staleAfterMs");
    assert.equal(await receiveAll(() => tr.receive([stale.name], async (m) => void got.push(m)), 1, 5000), 1);
    assert.deepEqual(got[0], { id: `evt-stale-${run}`, name: stale.name, payload: { orderId: "o-9", amount: 9 }, publishedAt: new Date("2026-11-07T10:00:00Z"), trace, tenantId: "acme" });
    await sleep(300);
    assert.equal(await tr.receive([stale.name], async (m) => void got.push(m)), 0, "committed");
  });

  test("events an instance did not deliver go to the next instance of the service after app.close()", { timeout: 120_000 }, async () => {
    const name = `stopped-${run}`;
    const first = service(name, await client(), { staleAfterMs: 3_600_000 }, stopped);
    await first.transport.send({ id: `evt-stop-${run}`, name: stopped.name, payload: { orderId: "o-1", amount: 1 }, publishedAt: new Date() });
    let failed = false;
    const until = Date.now() + 30_000;
    while (!failed && Date.now() < until) {
      await first.transport.receive([stopped.name], async () => Promise.reject(new Error("stopping"))).catch(() => (failed = true));
      await sleep(100);
    }
    assert.ok(failed);
    await first.app.close(); // closes the transport: the event was never committed
    const second = service(name, await client(), {}, stopped);
    assert.equal(await receiveAll(() => second.app.events.receive(), 1, 60_000), 1);
    await second.app.jobs.runDue();
    assert.deepEqual(second.runs.map((r) => (r.input as { orderId: string }).orderId), ["o-1"]);
  });
});
