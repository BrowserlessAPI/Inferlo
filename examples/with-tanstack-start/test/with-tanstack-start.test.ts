import assert from "node:assert/strict";
import { test } from "node:test";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import { toTanStackHandlers } from "../../../src/tanstack-start.ts";
import { makeApp } from "../src/inferlo/app.ts";
import { classifyHandler } from "../src/routes/classify.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };
// TanStack Start's handler needs Node.js module hooks to load its virtual entries; Bun and Deno run the other tests.
// (Older Bun releases ignore node:test's skip option, so the test is only declared on Node.js.)
const isNode = !("Bun" in globalThis) && !("Deno" in globalThis);

if (isNode) {
  test("TanStack Start's request handler serves the app from src/routes/api/$.ts", async () => {
    const { startHandler } = await import("../../../test/fixtures/tanstack-start/start-handler.ts");
    // The router entry is the project's own src/router.ts, with the route tree TanStack Router generated.
    const fetch = await startHandler(new URL("../src/router.ts", import.meta.url).href);
    const doc = await (await fetch(new Request("http://localhost:3000/api/openapi.json"))).json();
    assert.ok(doc.paths["/summaries"].post);
    const anon = await fetch(new Request("http://localhost:3000/api/summaries", { method: "POST", body: JSON.stringify({ text: "x" }) }));
    assert.equal(anon.status, 401);
    const invalid = await fetch(new Request("http://localhost:3000/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) }));
    assert.equal(invalid.status, 422);
    const empty = await fetch(new Request("http://localhost:3000/classify", { method: "POST", body: new URLSearchParams({ text: " " }) }));
    assert.equal(empty.status, 400);
  });
}

test("Inferlo routes call the AI and stream to the browser", async () => {
  const { POST, GET } = toTanStackHandlers(makeApp(mock()), { prefix: "/api" });
  const res = await POST({ request: new Request("http://localhost/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await GET({ request: new Request("http://localhost/api/chat?q=hi", { headers: signedIn }) });
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("a server route uses the AI module with structured output", async () => {
  const POST = classifyHandler(createAI(mock()));
  const form = (text: string) => new Request("http://localhost/classify", { method: "POST", body: new URLSearchParams({ text }) });
  assert.deepEqual(await (await POST({ request: form("How do I export?") })).json(), { label: "question" });
  assert.equal((await POST({ request: form(" ") })).status, 400);
});
