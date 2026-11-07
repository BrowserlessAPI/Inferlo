import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { eventsTransport } from "../src/events-transport.ts";

test("NATS JetStream event transport", () => {
  const source = readFileSync(new URL("../src/events-transport.ts", import.meta.url), "utf8");
  assert.match(source, /natsEventTransport\(/, "uses Inferlo's NATS transport");
  assert.match(source, /service:\s*["']bench-app["']/, "names the service like the app");
  assert.match(source, /staleAfterMs:\s*10_?000\b/, "redelivers after 10 seconds");
  // A stand-in connection: the transport talks to NATS only when events are sent or received.
  const nc = { publish() {}, request() {}, subscribe() {}, options: {} } as never;
  const transport = eventsTransport(nc);
  assert.equal(transport.name, "nats");
  const app = createApp({ name: "bench-app", events: { transport } });
  assert.equal(app.events.transport, "nats");
});
