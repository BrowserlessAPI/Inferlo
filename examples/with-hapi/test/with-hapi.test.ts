import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { makeServer } from "../src/app.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const json = { "content-type": "application/json" };

/** Starts the example server on a free port and returns its base URL. */
async function start() {
  const server = await makeServer(mock(), 0);
  await server.start();
  return { server, url: `http://127.0.0.1:${server.info.port}` };
}

test("the Inferlo app is served under /api with auth, validation and OpenAPI", async () => {
  const { server, url } = await start();
  try {
    const doc = await (await fetch(`${url}/api/openapi.json`)).json();
    assert.ok(doc.paths["/summaries"].post);
    assert.equal((await fetch(`${url}/api/summaries`, { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401);
    const signedIn = { ...json, authorization: "Bearer demo-token" };
    assert.equal((await fetch(`${url}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) })).status, 422);
    const ok = await fetch(`${url}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) });
    assert.deepEqual(await ok.json(), { summary: "A short summary." });
  } finally {
    await server.stop();
  }
});

test("hapi routes use request.ai, and AI answers stream", async () => {
  const { server, url } = await start();
  try {
    const classified = await fetch(`${url}/classify`, { method: "POST", headers: json, body: JSON.stringify({ text: "How do I export?" }) });
    assert.deepEqual(await classified.json(), { label: "question" });
    const res = await fetch(`${url}/api/chat?q=hi`);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "A short summary.");
  } finally {
    await server.stop();
  }
});
