import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { IgnitorFactory } from "@adonisjs/core/factories";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import rc from "../adonisrc.ts";

const ai = createAI({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

let http: Server;
let base = "";
let terminate = async () => {};

before(async () => {
  // Boots the app from adonisrc.ts, with config/ai.ts replaced by a mock client.
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .merge({ rcFileContents: rc, config: { ai } })
    .create(new URL("../", import.meta.url), { importer: (path) => import(path) });
  const app = ignitor.createApp("web");
  await app.init();
  await app.boot();
  await app.start(async () => {});
  const server = await app.container.make("server");
  await server.boot();
  http = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  terminate = () => app.terminate();
});

after(async () => {
  http?.close();
  await terminate();
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a route uses ctx.ai from the provider with structured output", async () => {
  const res = await post("/classify", { text: "How do I export?" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { label: "question" });
  assert.equal((await post("/classify", { text: "" })).status, 422);
});

test("code outside an HTTP context resolves the client from the container", async () => {
  const res = await post("/summaries", { text: "A long text." });
  assert.deepEqual(await res.json(), { summary: "A short summary." });
});
