import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { mockProvider } from "../src/ai/public.ts";
import { createApp, route, t } from "../src/index.ts";

// The setups docs/deploy.md recommends on Deno: Deno.serve(app.fetch), and deno serve (as on Deno Deploy) with the
// app as the module's default export. Runs under `deno test` (npm run test:deno); skipped on Node.js and Bun.
type DenoServer = { addr: { port: number }; finished: Promise<void>; shutdown(): Promise<void> };
type DenoChild = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; status: Promise<unknown>; kill(signal: string): void };
type DenoNs = {
  serve(options: object, handler: (req: Request, info: unknown) => Response | Promise<Response>): DenoServer;
  execPath(): string;
  Command: new (command: string, options: { args: string[]; stdout: "piped"; stderr: "piped" }) => { spawn(): DenoChild };
};
const Deno = (globalThis as { Deno?: DenoNs }).Deno;
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "deno-serve-app.ts");

function makeApp() {
  const routes = {
    hello: route.get("/api/hello", { auth: "public", query: t.object({ name: t.string().default("world") }) }).handle(({ query }) => ({ hello: query.name })),
    limited: route.get("/api/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true })),
    chat: route.get("/api/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
    // A model that pauses between tokens.
    slow: route.get("/api/slow", { auth: "public" }).handle(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('event: text\ndata: "Hello"\n\n'));
              await new Promise((resolve) => setTimeout(resolve, 300));
              controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  };
  return createApp({
    name: "deno-serve-test",
    routes: [routes],
    health: true,
    logger: { info() {}, error() {} },
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

const serve = (app: ReturnType<typeof makeApp>) => Deno!.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, app.fetch);

// describe.skip off Deno, because Bun 1.3.0 ignores { skip } on describe.
(Deno ? describe : describe.skip)("Deno.serve(app.fetch)", () => {
  test("serves the app with the client address from Deno's info, and streams AI answers", async () => {
    const app = makeApp();
    const server = serve(app);
    try {
      const base = `http://127.0.0.1:${server.addr.port}`;
      assert.deepEqual(await (await fetch(`${base}/api/hello?name=deno`)).json(), { hello: "deno" });
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/api/limited`)).status, 200);
      const limited = await fetch(`${base}/api/limited`);
      assert.equal(limited.status, 429, "rate limits by IP use Deno's info.remoteAddr");
      await limited.body?.cancel();
      const chat = await fetch(`${base}/api/chat`);
      assert.match(chat.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = [...(await chat.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
      assert.equal(text, "Hello from AI.");
      assert.match(await (await fetch(`${base}/api/slow`)).text(), /event: done/);
    } finally {
      await app.close();
      await server.shutdown();
    }
  });

  test("graceful shutdown: app.close() turns /ready to 503 and refuses new requests, a streaming answer finishes, then server.shutdown() closes", async () => {
    const app = makeApp();
    const server = serve(app);
    const base = `http://127.0.0.1:${server.addr.port}`;
    assert.equal((await (await fetch(`${base}/ready`)).json()).status, "ready");
    const slow = await fetch(`${base}/api/slow`);
    await app.close();
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    await ready.body?.cancel();
    const refused = await fetch(`${base}/api/hello`);
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error.code, "IL2006");
    assert.match(await slow.text(), /event: done/, "an answer that was streaming finishes");
    await server.shutdown();
    await server.finished;
    await assert.rejects(fetch(`${base}/api/hello`));
  });

  test("ctx.signal aborts when the client disconnects from a streamed answer", async () => {
    let onDisconnect: () => void;
    const disconnected = new Promise<void>((resolve) => (onDisconnect = resolve));
    const app = createApp({
      routes: [
        {
          endless: route.get("/endless", { auth: "public" }).handle(({ signal }) => {
            signal.addEventListener("abort", () => onDisconnect());
            return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("start\n")) }));
          }),
        },
      ],
      logger: { info() {}, error() {} },
    });
    const server = Deno!.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, app.fetch);
    try {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${server.addr.port}/endless`, { signal: controller.signal });
      await res.body!.getReader().read();
      controller.abort();
      await disconnected;
    } finally {
      await app.close({ timeoutMs: 200 });
      await server.shutdown();
    }
  });

  test("deno serve runs a module whose default export is the app", { timeout: 30_000 }, async () => {
    // Deno.Command, not node:child_process: Deno 2.9.0's child_process reads the arguments of a Deno process as Node.js ones.
    const child = new Deno!.Command(Deno!.execPath(), { args: ["serve", "-A", "--port=0", "--host=127.0.0.1", fixture], stdout: "piped", stderr: "piped" }).spawn();
    const decoder = new TextDecoder();
    let output = "";
    const watch = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) output += decoder.decode(part.value, { stream: true });
    };
    const reading = Promise.all([watch(child.stdout), watch(child.stderr)]);
    try {
      let url: string | undefined;
      for (let i = 0; i < 400 && !url; i++) {
        url = /Listening on (http:\/\/[^\s]+?)\/?\s/.exec(output)?.[1];
        if (!url) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(url, `deno serve did not start: ${output}`);
      assert.deepEqual(await (await fetch(`${url}/hello?name=deploy`)).json(), { hello: "deploy" });
      const missing = await fetch(`${url}/nope`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "IL2001");
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await reading;
    }
  });
});
