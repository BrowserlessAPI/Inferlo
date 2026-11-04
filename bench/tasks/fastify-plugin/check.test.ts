import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the Fastify app uses inferloPlugin for request.ai and serves the Inferlo app under /api", async () => {
  const source = readFileSync(new URL("../src/fastify.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/fastify/, "uses the Fastify entry point");
  assert.match(source, /inferloPlugin/, "uses inferloPlugin");
  assert.match(source, /request\.ai|req\.ai/, "reads the AI client from the request");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: { body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
    requests.push({ body: JSON.parse(String(init!.body)) });
    return Response.json({ content: [{ type: "text", text: "Hallo Welt" }], usage: { input_tokens: 5, output_tokens: 2 } });
  }) as typeof fetch;

  const { buildServer } = await import("../src/fastify.ts");
  const fastify = await buildServer();
  try {
    const res = await fastify.inject({ method: "POST", url: "/translate", payload: { text: "Hello world", to: "German" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { translation: "Hallo Welt" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.model, "claude-haiku-4-5");
    assert.match(JSON.stringify(requests[0]!.body), /Hello world/);
    assert.match(JSON.stringify(requests[0]!.body), /German/);

    const health = await fastify.inject("/api/health");
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });
    assert.equal((await fastify.inject("/api/notes")).statusCode, 401, "the Inferlo app's auth still applies");
  } finally {
    await fastify.close();
  }
});
