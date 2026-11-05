import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestEvent, ServerLoadEvent } from "@sveltejs/kit";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import { inferloAI, toSvelteKitHandlers } from "../../../src/sveltekit.ts";
import { handle } from "../src/hooks.server.ts";
import { makeApp } from "../src/lib/server/inferlo.ts";
import * as api from "../src/routes/api/[...path]/+server.ts";
import { actions, load } from "../src/routes/classify/+page.server.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };
const event = (url: string, init?: RequestInit) => ({ request: new Request(url, init), getClientAddress: () => "127.0.0.1", locals: {} });

test("the rest route exports a handler per method and a fallback that serve the app under /api", async () => {
  assert.deepEqual(Object.keys(api).sort(), ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "fallback"]);
  const doc = await (await api.GET(event("http://localhost:5173/api/openapi.json"))).json();
  assert.ok(doc.paths["/summaries"].post);
  const anon = await api.POST(event("http://localhost:5173/api/summaries", { method: "POST", body: JSON.stringify({ text: "x" }) }));
  assert.equal(anon.status, 401);
  const invalid = await api.POST(event("http://localhost:5173/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) }));
  assert.equal(invalid.status, 422);
});

test("Inferlo routes call the AI and stream to the browser", async () => {
  const { GET, POST } = toSvelteKitHandlers(makeApp(mock()), { prefix: "/api" });
  const res = await POST(event("http://localhost/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await GET(event("http://localhost/api/chat?q=hi", { headers: signedIn }));
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("the handle hook sets locals.ai, and the load function and form action use it", async () => {
  // The hook from src/hooks.server.ts, then the same hook with a mock client, run the way SvelteKit does before a page.
  const real = { locals: {} as App.Locals, request: new Request("http://localhost/classify") };
  await handle({ event: real as never, resolve: async () => new Response("") });
  assert.equal(typeof real.locals.ai.generate, "function");

  const locals = {} as App.Locals;
  await inferloAI(createAI(mock()))({ event: { locals }, resolve: async () => new Response("") });
  const page = await load({ locals } as unknown as ServerLoadEvent);
  assert.deepEqual(page, { greeting: "A short summary." });

  const form = (text: string) => ({ locals, request: new Request("http://localhost/classify", { method: "POST", body: new URLSearchParams({ text }) }) }) as unknown as RequestEvent;
  assert.deepEqual(await actions.default(form("How do I export?")), { label: "question" });
  const empty = (await actions.default(form("  "))) as { status: number; data: { error: string } };
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.data, { error: "Enter a message." });
});
