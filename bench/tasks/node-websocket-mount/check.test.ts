import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyServer } from "../src/legacy.ts";

function roundTrip(url: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify(message));
    ws.onmessage = (event) => {
      resolve(JSON.parse(String(event.data)));
      ws.close();
    };
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

test("HTTP requests and WebSockets under /api reach the Inferlo app", async () => {
  const server = createLegacyServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${port}/api/ticker`, { symbol: "ACME" }), { symbol: "ACME", price: 100 });
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/status`)).text(), "legacy");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
