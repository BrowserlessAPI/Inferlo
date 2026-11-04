import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { makeElysia } from "../src/app.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

const call = (app: ReturnType<typeof makeElysia>, path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

test("an Elysia route uses ai from the context with structured output", async () => {
  const res = await call(makeElysia(mock()), "/classify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "How do I export?" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { label: "question" });
});

test("the Inferlo app under /api keeps its auth, validation and OpenAPI", async () => {
  const app = makeElysia(mock());
  const json = { "content-type": "application/json" };
  assert.equal((await call(app, "/api/summaries", { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401);
  const signedIn = { ...json, authorization: "Bearer demo-token" };
  assert.equal((await call(app, "/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) })).status, 422);
  const ok = await call(app, "/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "A long text." }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { summary: "A short summary." });
  assert.ok((await (await call(app, "/api/openapi.json")).json()).paths["/summaries"]);
});
