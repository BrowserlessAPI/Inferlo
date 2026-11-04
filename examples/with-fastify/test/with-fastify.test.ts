import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { makeServer } from "../src/app.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

test("a Fastify route uses request.ai with structured output", async () => {
  const fastify = await makeServer(mock());
  const res = await fastify.inject({ method: "POST", url: "/classify", payload: { text: "How do I export?" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { label: "question" });
  await fastify.close();
});

test("a Fastify route streams AI text", async () => {
  const fastify = await makeServer(mock());
  const res = await fastify.inject("/chat?q=hi");
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  const text = [...res.body.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
  await fastify.close();
});

test("the Inferlo app under /api keeps its auth, validation and OpenAPI", async () => {
  const fastify = await makeServer(mock());
  assert.equal((await fastify.inject({ method: "POST", url: "/api/summaries", payload: { text: "x" } })).statusCode, 401);
  const headers = { authorization: "Bearer demo-token" };
  assert.equal((await fastify.inject({ method: "POST", url: "/api/summaries", headers, payload: { text: "" } })).statusCode, 422);
  const ok = await fastify.inject({ method: "POST", url: "/api/summaries", headers, payload: { text: "A long text." } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { summary: "A short summary." });
  assert.ok((await fastify.inject("/api/openapi.json")).json().paths["/summaries"]);
  await fastify.close();
});
