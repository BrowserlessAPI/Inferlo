import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the Hono app uses inferloAI() and mounts the Inferlo app under /api", async () => {
  const source = readFileSync(new URL("../src/hono.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/hono/, "uses the Hono entry point");
  assert.match(source, /inferloAI\(/, "uses the inferloAI() middleware");
  assert.match(source, /c\.var\.ai|c\.get\(["']ai["']\)/, "reads the AI client from the context");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return Response.json({ content: [{ type: "text", text: "Hallo Welt" }], usage: { input_tokens: 5, output_tokens: 2 } });
  }) as typeof fetch;

  const { hono } = await import("../src/hono.ts");
  const res = await hono.request("/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello world", to: "German" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { translation: "Hallo Welt" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.body.model, "claude-haiku-4-5");
  assert.match(JSON.stringify(requests[0]!.body), /Hello world/);
  assert.match(JSON.stringify(requests[0]!.body), /German/);

  const health = await hono.request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});
