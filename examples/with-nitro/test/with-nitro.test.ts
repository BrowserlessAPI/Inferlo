// Serves the server/ folder the way Nitro does: plugins run first and add their request hooks, routes come from
// the file names (server/routes/api/[...path].ts is /api/**, classify.post.ts is POST /classify).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import * as h3 from "h3";

// The model, answered without a network call.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!String(input instanceof Request ? input.url : input).includes("api.anthropic.com")) return realFetch(input, init);
  const text = String(init?.body).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.";
  return Response.json({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 3 } });
}) as typeof fetch;

const lib = h3 as any;
let server: Server;
let base = "";
before(async () => {
  // Imported after the fetch stub above, because the app's AI provider is created when the module loads.
  const { default: apiRoute } = await import("../server/routes/api/[...path].ts");
  const { default: classify } = await import("../server/routes/classify.post.ts");
  const { default: aiPlugin } = await import("../server/plugins/ai.ts");
  const requestHooks: ((event: any) => void)[] = [];
  aiPlugin({ hooks: { hook: (_name: string, fn: (event: any) => void) => void requestHooks.push(fn) } });
  const runHooks = (event: any) => void requestHooks.forEach((fn) => fn(event));
  let listener;
  if (typeof lib.H3 === "function") {
    const app = new lib.H3();
    app.use(runHooks);
    app.post("/classify", classify);
    app.all("/api/**", apiRoute);
    listener = (await import("h3/node" as string)).toNodeHandler(app);
  } else {
    const app = lib.createApp();
    app.use(lib.eventHandler(runHooks));
    const router = lib.createRouter();
    router.post("/classify", classify);
    router.use("/api/**", apiRoute);
    app.use(router);
    listener = lib.toNodeListener(app);
  }
  server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  globalThis.fetch = realFetch;
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = { "content-type": "application/json" };

test("a Nitro server route uses event.context.ai with structured output", async () => {
  const res = await fetch(`${base}/classify`, { method: "POST", headers: json, body: JSON.stringify({ text: "How do I export?" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { label: "question" });
});

test("the Inferlo app answers under /api with its auth and validation", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: json, body: JSON.stringify({ text: "Hi" }) })).status, 401);
  const auth = { ...json, authorization: "Bearer demo-token" };
  const invalid = await fetch(`${base}/api/summaries`, { method: "POST", headers: auth, body: JSON.stringify({ text: "" }) });
  assert.equal((await invalid.json()).error.code, "IL1001");
  const res = await fetch(`${base}/api/summaries`, { method: "POST", headers: auth, body: JSON.stringify({ text: "A long support thread." }) });
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/summaries"]);
});
