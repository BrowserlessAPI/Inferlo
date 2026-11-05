import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server.js";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import { toNextHandlers } from "../../../src/nextjs.ts";
import * as handlers from "../app/api/[[...path]]/route.ts";
import { makeApp } from "../inferlo/app.ts";
import { classifyText } from "../lib/classify.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

test("the catch-all route exports a handler per method that serves the app under /api", async () => {
  assert.deepEqual(Object.keys(handlers).sort(), ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
  const doc = await (await handlers.GET(new NextRequest("http://localhost:3000/api/openapi.json"))).json();
  assert.ok(doc.paths["/summaries"].post);
  const anon = await handlers.POST(new NextRequest("http://localhost:3000/api/summaries", { method: "POST", body: JSON.stringify({ text: "x" }) }));
  assert.equal(anon.status, 401);
  const invalid = await handlers.POST(new NextRequest("http://localhost:3000/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) }));
  assert.equal(invalid.status, 422);
});

test("Inferlo routes call the AI and stream to the browser", async () => {
  const { GET, POST } = toNextHandlers(makeApp(mock()), { prefix: "/api" });
  const res = await POST(new NextRequest("http://localhost/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await GET(new NextRequest("http://localhost/api/chat?q=hi", { headers: signedIn }));
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("server actions use the AI module with structured output", async () => {
  assert.deepEqual(await classifyText(createAI(mock()), "How do I export?"), { label: "question" });
});
