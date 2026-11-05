import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { makeServer } from "../src/app.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

test("the Inferlo app is served under /api with auth, validation and OpenAPI", async () => {
  const server = await makeServer(mock(), 0);
  const doc = JSON.parse((await server.inject("/api/openapi.json")).payload);
  assert.ok(doc.paths["/summaries"].post);
  assert.equal((await server.inject({ method: "POST", url: "/api/summaries", payload: { text: "x" } })).statusCode, 401);
  const headers = { authorization: "Bearer demo-token" };
  assert.equal((await server.inject({ method: "POST", url: "/api/summaries", payload: { text: "" }, headers })).statusCode, 422);
  const ok = await server.inject({ method: "POST", url: "/api/summaries", payload: { text: "Long text" }, headers });
  assert.deepEqual(JSON.parse(ok.payload), { summary: "A short summary." });
});

test("hapi routes use request.ai, and AI answers stream", async () => {
  const server = await makeServer(mock(), 0);
  const classified = await server.inject({ method: "POST", url: "/classify", payload: { text: "How do I export?" } });
  assert.deepEqual(JSON.parse(classified.payload), { label: "question" });
  await server.start();
  try {
    const res = await fetch(`${server.info.uri.replace("0.0.0.0", "127.0.0.1")}/api/chat?q=hi`);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "A short summary.");
  } finally {
    await server.stop();
  }
});
