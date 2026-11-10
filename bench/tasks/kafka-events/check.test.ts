import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { eventsTransport } from "../src/events-transport.ts";

test("Kafka event transport", async () => {
  const source = readFileSync(new URL("../src/events-transport.ts", import.meta.url), "utf8");
  assert.match(source, /kafkaEventTransport\(/, "uses Inferlo's Kafka transport");
  assert.match(source, /service:\s*["']bench-app["']/, "names the service like the app");
  // A stand-in client that records how topics are created; the transport connects only when events are sent.
  const created: unknown[] = [];
  const sent: string[] = [];
  const kafka = {
    admin: () => ({ connect: async () => {}, disconnect: async () => {}, createTopics: async (o: { topics: unknown[] }) => (created.push(...o.topics), true) }),
    producer: () => ({ connect: async () => {}, disconnect: async () => {}, send: async (r: { topic: string }) => void sent.push(r.topic) }),
    consumer: () => ({ connect: async () => {}, disconnect: async () => {}, subscribe: async () => {}, run: async () => {} }),
  };
  const transport = eventsTransport(kafka as never);
  assert.equal(transport.name, "kafka");
  const app = createApp({ name: "bench-app", events: { transport } });
  assert.equal(app.events.transport, "kafka");
  await transport.send({ id: "e1", name: "order.paid", payload: {}, publishedAt: new Date() });
  assert.deepEqual(created, [{ topic: "inferlo.events.order.paid", numPartitions: 6 }]);
  assert.deepEqual(sent, ["inferlo.events.order.paid"]);
  assert.match(source, /staleAfterMs:\s*10[_]?000\b/, "retries a failed delivery after 10 seconds");
  await app.close();
});
