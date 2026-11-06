import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import handler, { config } from "../netlify/functions/api.ts";
import { makeApp } from "../src/app.ts";

// Calls shaped like the ones Netlify Functions 2.0 make: handler(request, context), with the client address in context.ip.
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };
const mock = () => ({ providers: { anthropic: mockProvider({ respond: () => "A short summary." }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
const context = (ip = "203.0.113.9") => ({ ip, requestId: "01JNETLIFYREQUEST", geo: {}, params: {}, waitUntil: (p: Promise<unknown>) => void p });
const url = (path: string) => `https://notes.netlify.app${path}`;

test("the function serves the app under /api/", async () => {
  assert.equal(config.path, "/api/*");
  assert.deepEqual(await (await handler(new Request(url("/api/status")), context())).json(), { ok: true });
  assert.equal((await handler(new Request(url("/api/summaries"), { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), context())).status, 401);
  assert.equal((await handler(new Request(url("/api/summaries"), { method: "POST", body: JSON.stringify({ text: "" }), headers: signedIn }), context())).status, 422);
});

test("routes call the AI and stream its answer", async () => {
  const app = makeApp(mock());
  const res = await app.fetch(new Request(url("/api/summaries"), { method: "POST", body: JSON.stringify({ text: "Long text" }), headers: signedIn }), context());
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await app.fetch(new Request(url("/api/chat?q=Hi"), { headers: signedIn }), context());
  const text = await stream.text();
  assert.equal([...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string).join(""), "A short summary.");
});

test("rate limits count each client by context.ip", async () => {
  const app = makeApp(mock());
  for (let i = 0; i < 60; i++) assert.equal((await app.fetch(new Request(url("/api/status")), context("198.51.100.1"))).status, 200);
  assert.equal((await app.fetch(new Request(url("/api/status")), context("198.51.100.1"))).status, 429);
  assert.equal((await app.fetch(new Request(url("/api/status")), context("198.51.100.2"))).status, 200);
});
