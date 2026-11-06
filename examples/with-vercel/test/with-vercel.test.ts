import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import handler from "../api/index.ts";
import { makeApp } from "../src/app.ts";

// Requests shaped like the ones Vercel's Node.js runtime passes to a fetch export: the original URL after the
// vercel.json rewrite, and the client address in X-Real-IP (Vercel sets it and VERCEL=1 on every deployment).
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };
const mock = () => ({ providers: { anthropic: mockProvider({ respond: () => "A short summary." }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
const previous = process.env.VERCEL;
before(() => void (process.env.VERCEL = "1"));
after(() => {
  if (previous === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = previous;
});

const vercelRequest = (path: string, init: RequestInit & { ip?: string } = {}) =>
  new Request(`https://notes.vercel.app${path}`, { ...init, headers: { "x-real-ip": init.ip ?? "203.0.113.9", "x-forwarded-for": init.ip ?? "203.0.113.9", "x-vercel-id": "fra1::abc", ...(init.headers as Record<string, string>) } });

test("the function's default export serves the app: OpenAPI, auth and validation", async () => {
  assert.equal(typeof handler.fetch, "function");
  const doc = (await (await handler.fetch(vercelRequest("/openapi.json"))).json()) as { paths: Record<string, unknown> };
  assert.ok(doc.paths["/api/summaries"]);
  assert.deepEqual(await (await handler.fetch(vercelRequest("/api/status"))).json(), { ok: true });
  assert.equal((await handler.fetch(vercelRequest("/api/summaries", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status, 401);
  assert.equal((await handler.fetch(vercelRequest("/api/summaries", { method: "POST", body: JSON.stringify({ text: "" }), headers: signedIn }))).status, 422);
});

test("routes call the AI and stream its answer", async () => {
  const app = makeApp(mock());
  const res = await app.fetch(vercelRequest("/api/summaries", { method: "POST", body: JSON.stringify({ text: "Long text" }), headers: signedIn }));
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await app.fetch(vercelRequest("/api/chat?q=Hi", { headers: signedIn }));
  const text = await stream.text();
  assert.equal([...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string).join(""), "A short summary.");
});

test("rate limits count each client by the address Vercel sets", async () => {
  const app = makeApp(mock());
  for (let i = 0; i < 60; i++) assert.equal((await app.fetch(vercelRequest("/api/status", { ip: "198.51.100.1" }))).status, 200);
  assert.equal((await app.fetch(vercelRequest("/api/status", { ip: "198.51.100.1" }))).status, 429);
  assert.equal((await app.fetch(vercelRequest("/api/status", { ip: "198.51.100.2" }))).status, 200);
});
