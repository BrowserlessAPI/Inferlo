import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { makeServer } from "../src/app.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

let base = "";
let close: () => Promise<void>;
before(async () => {
  const http = makeServer(mock()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => http.close(() => resolve()));
});
after(() => close());

const json = { "content-type": "application/json" };

test("an Express route uses req.ai with structured output", async () => {
  const res = await fetch(`${base}/classify`, { method: "POST", headers: json, body: JSON.stringify({ text: "How do I export?" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { label: "question" });
});

test("an Express route streams AI text", async () => {
  const res = await fetch(`${base}/chat?q=hi`);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("the Inferlo app under /api keeps its auth, validation and OpenAPI", async () => {
  assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401);
  const signedIn = { ...json, authorization: "Bearer demo-token" };
  assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) })).status, 422);
  const ok = await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "A long text." }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { summary: "A short summary." });
  assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/summaries"]);
});
