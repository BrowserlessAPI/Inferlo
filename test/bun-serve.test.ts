import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mockProvider } from "../src/ai/public.ts";
import { createApp, route, t } from "../src/index.ts";

// The setup docs/deploy.md recommends on Bun: Bun.serve with Bun's own routes for static pages and the Inferlo app as
// the fetch handler for everything else. Runs under `bun test`; skipped on Node.js.
type BunServer = { port: number; pendingRequests: number; stop(closeActiveConnections?: boolean): Promise<void> | void };
const Bun = (globalThis as { Bun?: { serve(options: object): BunServer } }).Bun;

function makeApp() {
  const routes = {
    hello: route.get("/api/hello", { auth: "public", query: t.object({ name: t.string().default("world") }) }).handle(({ query }) => ({ hello: query.name })),
    limited: route.get("/api/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true })),
    chat: route.get("/api/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
    // A model that pauses between tokens for longer than the server's idleTimeout.
    slow: route.get("/api/slow", { auth: "public" }).handle(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("event: text\ndata: \"Hello\"\n\n"));
              await new Promise((resolve) => setTimeout(resolve, 5_000));
              controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  };
  return createApp({
    name: "bun-serve-test",
    routes: [routes],
    health: true,
    logger: { info() {}, error() {} },
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

describe("Bun.serve({ routes, fetch: app.fetch })", { skip: Bun ? false : "runs on Bun only" }, () => {
  test("Bun's routes and the Inferlo app share one server; the app gets the client address", async () => {
    const app = makeApp();
    const server = Bun!.serve({ port: 0, hostname: "127.0.0.1", routes: { "/": new Response("<h1>Home</h1>", { headers: { "content-type": "text/html" } }) }, fetch: app.fetch });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal(await (await fetch(`${base}/`)).text(), "<h1>Home</h1>");
      assert.deepEqual(await (await fetch(`${base}/api/hello?name=bun`)).json(), { hello: "bun" });
      assert.equal((await fetch(`${base}/api/hello?name=`)).status, 200);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/api/limited`)).status, 200);
      const limited = await fetch(`${base}/api/limited`);
      assert.equal(limited.status, 429, "rate limits by IP use Bun's server.requestIP");
      const chat = await fetch(`${base}/api/chat`);
      assert.match(chat.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = [...(await chat.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
      assert.equal(text, "Hello from AI.");
    } finally {
      await app.close();
      await server.stop(true);
    }
  });

  test("server-sent events stay open past Bun's idleTimeout, so a model may pause between tokens", { timeout: 10_000 }, async () => {
    const app = makeApp();
    const server = Bun!.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 1, fetch: app.fetch });
    try {
      const text = await (await fetch(`http://127.0.0.1:${server.port}/api/slow`)).text();
      assert.match(text, /event: done/, "the stream was not closed after 1 s without data");
    } finally {
      await app.close();
      await server.stop(true);
    }
  });

  test("graceful shutdown: app.close() turns /ready to 503 and refuses new requests, then server.stop() closes", async () => {
    const app = makeApp();
    const server = Bun!.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    const chat = await fetch(`${base}/api/chat`);
    await app.close();
    assert.equal((await fetch(`${base}/ready`, { headers: { connection: "close" } })).status, 503);
    const refused = await fetch(`${base}/api/hello`, { headers: { connection: "close" } });
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error.code, "IL2006");
    assert.match(await chat.text(), /event: done/, "an answer that was streaming finishes");
    await server.stop(true);
    await assert.rejects(fetch(`${base}/api/hello`));
  });
});
