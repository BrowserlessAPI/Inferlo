import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import { inferloAI, toAstroHandler } from "../../../src/astro.ts";
import { makeApp } from "../src/lib/inferlo.ts";
import { onRequest } from "../src/middleware.ts";
import * as api from "../src/pages/api/[...path].ts";
import * as classify from "../src/pages/classify.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };
const container = await AstroContainer.create();
const render = (endpoint: object, url: string, init?: RequestInit, locals: object = {}) =>
  container.renderToResponse(endpoint as never, { routeType: "endpoint", request: new Request(url, init), locals } as never);

test("the catch-all endpoint serves the app under /api, server-rendered", async () => {
  assert.deepEqual(Object.keys(api).sort(), ["ALL", "prerender"]);
  assert.equal(api.prerender, false);
  const doc = await (await render(api, "http://localhost:4321/api/openapi.json")).json();
  assert.ok(doc.paths["/summaries"].post);
  const anon = await render(api, "http://localhost:4321/api/summaries", { method: "POST", body: JSON.stringify({ text: "x" }) });
  assert.equal(anon.status, 401);
  const invalid = await render(api, "http://localhost:4321/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) });
  assert.equal(invalid.status, 422);
});

test("Inferlo routes call the AI and stream to the browser", async () => {
  const endpoint = { ALL: toAstroHandler(makeApp(mock()), { prefix: "/api" }), prerender: false };
  const res = await render(endpoint, "http://localhost/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await render(endpoint, "http://localhost/api/chat?q=hi", { headers: signedIn });
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("the middleware sets locals.ai, and the endpoint uses it", async () => {
  // The middleware from src/middleware.ts, then the same middleware with a mock client, run the way Astro does.
  const real = { locals: {} as App.Locals, request: new Request("http://localhost/") };
  await onRequest(real, async () => new Response(""));
  assert.equal(typeof real.locals.ai.generate, "function");

  const locals = {} as App.Locals;
  await inferloAI(createAI(mock()))({ locals }, async () => new Response(""));
  const form = (text: string) => ({ method: "POST", body: new URLSearchParams({ text }) });
  const res = await render(classify, "http://localhost/classify", form("How do I export?"), locals);
  assert.deepEqual(await res.json(), { label: "question" });
  const empty = await render(classify, "http://localhost/classify", form("  "), locals);
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "Enter a message." });
});
