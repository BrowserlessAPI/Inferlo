import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as assistant from "../src/routes/assistant.ts";

test("answers are streamed over the socket as they are generated, with usage for the user", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*assistant/, "registers the assistant routes");
  const usage: { for?: string }[] = [];
  const ada = { id: "11111111-1111-4111-8111-111111111111", email: "ada@x.io", name: "Ada", roles: [] };
  const app = createApp({
    models,
    db: memory(),
    routes: [assistant],
    auth: { resolve: (req) => (req.headers.get("authorization") === "Bearer ada" ? ada : null) },
    ai: { providers: { mock: mockProvider({ respond: () => "Paris is the capital of France." }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) },
    logger: { info() {}, error() {} },
  });
  const server = await app.listen(0, "127.0.0.1");
  try {
    const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
    const ws = new WS(`ws://127.0.0.1:${server.port}/assistant`, { headers: { authorization: "Bearer ada" } });
    const received: { type?: string; text?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ question: "What is the capital of France?" }));
      ws.onmessage = (event) => {
        const m = JSON.parse(String(event.data));
        received.push(m);
        if (m.type === "done" || m.error) resolve();
      };
      ws.onerror = () => reject(new Error("connection refused"));
    });
    ws.close();
    const texts = received.filter((m) => m.type === "text");
    assert.ok(texts.length > 1, "the answer arrives in several chunks (socket.stream)");
    assert.equal(texts.map((m) => m.text).join(""), "Paris is the capital of France.");
    assert.equal(usage[0]?.for, ada.id, "usage is tracked for the user");
  } finally {
    await app.close({ timeoutMs: 1000 });
  }
});
