import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { workerModules, type WorkerModule } from "./workerd.ts";

// Runs test/fixtures/workers-app.ts (export default app) in workerd, the Cloudflare Workers runtime, through Miniflare.
// The Cloudflare Workers CI job runs this file on the oldest supported and the latest Miniflare (workerd).
const isBun = "Bun" in globalThis;

// Miniflare runs workerd from Node.js. describe.skip, because Bun 1.3.0 ignores the skip option of describe.
(isBun ? describe.skip : describe)("Cloudflare Workers (workerd)", () => {
  type Mf = { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> };
  let mf: Mf;
  const llmRequests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];

  // Every fetch the Worker makes to the model provider reaches this function instead of the network.
  async function provider(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    llmRequests.push({ url: request.url, authorization: request.headers.get("authorization"), body });
    if (body.stream) {
      const events = ["Hello", " from", " workerd"].map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      events.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } })}\n\n`, "data: [DONE]\n\n");
      return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ model: "small", choices: [{ message: { content: "A short summary." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  }

  before(async () => {
    const { Miniflare } = await import("miniflare");
    const modules: WorkerModule[] = workerModules(new URL("./fixtures/workers-app.ts", import.meta.url).pathname, process.cwd());
    mf = new Miniflare({
      modules,
      compatibilityDate: "2025-04-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { GREETING: "Hello from a binding", API_KEY: "sk-test-123" },
      outboundService: provider,
    }) as unknown as Mf;
  });
  after(async () => {
    await mf?.dispose();
  });

  test("export default app serves routes, and config() and env() read Worker bindings", async () => {
    const res = await mf.dispatchFetch("https://api.example.com/greeting");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-request-id"));
    assert.deepEqual(await res.json(), { greeting: "Hello from a binding", fromEnv: "Hello from a binding", limit: 2 });
  });

  test("validation errors, unknown routes and OpenAPI work as on other runtimes", async () => {
    const bad = await mf.dispatchFetch("https://api.example.com/summary", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 422);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "IL1001");
    assert.equal((await mf.dispatchFetch("https://api.example.com/nothing")).status, 404);
    const openapi = (await (await mf.dispatchFetch("https://api.example.com/openapi.json")).json()) as { paths: Record<string, unknown> };
    assert.ok(openapi.paths["/summary"]);
  });

  test("rate limits by IP use CF-Connecting-IP, the address Cloudflare sets", async () => {
    const hit = (ip: string) => mf.dispatchFetch("https://api.example.com/limited", { headers: { "cf-connecting-ip": ip } });
    assert.equal((await hit("203.0.113.7")).status, 200);
    assert.equal((await hit("203.0.113.7")).status, 429);
    assert.equal((await hit("198.51.100.4")).status, 200, "another client has its own count");
  });

  test("ctx.waitUntil hands work to the Worker's execution context", async () => {
    const res = await mf.dispatchFetch("https://api.example.com/background", { method: "POST" });
    assert.deepEqual(await res.json(), { queued: true });
    let later: string[] = [];
    for (let i = 0; i < 50 && !later.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      later = ((await (await mf.dispatchFetch("https://api.example.com/background")).json()) as { later: string[] }).later;
    }
    assert.deepEqual(later, ["done"]);
  });

  test("the AI module calls the provider with fetch from the Worker", async () => {
    llmRequests.length = 0;
    const res = await mf.dispatchFetch("https://api.example.com/summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A long text." }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "A short summary.", inputTokens: 12 });
    assert.equal(llmRequests.length, 1);
    assert.equal(llmRequests[0]!.url, "https://llm.example.com/v1/chat/completions");
    assert.equal(llmRequests[0]!.authorization, "Bearer sk-test-123");
    assert.equal(llmRequests[0]!.body.model, "small");
  });

  test("AI answers stream to the client as server-sent events", async () => {
    const res = await mf.dispatchFetch("https://api.example.com/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi" }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    const chunks = [...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string);
    assert.equal(chunks.join(""), "Hello from workerd");
    assert.match(text, /event: done\ndata: .*"inputTokens":4/);
  });
});
