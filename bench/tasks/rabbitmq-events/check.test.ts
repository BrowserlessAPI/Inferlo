import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { eventsTransport } from "../src/events-transport.ts";

test("RabbitMQ event transport", () => {
  const source = readFileSync(new URL("../src/events-transport.ts", import.meta.url), "utf8");
  assert.match(source, /rabbitmqEventTransport\(/, "uses Inferlo's RabbitMQ transport");
  assert.match(source, /service:\s*["']bench-app["']/, "names the service like the app");
  assert.match(source, /queueType:\s*["']classic["']/, "uses classic queues");
  // A stand-in connection: the transport opens channels only when events are sent or received.
  const connection = { createChannel() {}, createConfirmChannel() {} } as never;
  const transport = eventsTransport(connection);
  assert.equal(transport.name, "rabbitmq");
  const app = createApp({ name: "bench-app", events: { transport } });
  assert.equal(app.events.transport, "rabbitmq");
});
