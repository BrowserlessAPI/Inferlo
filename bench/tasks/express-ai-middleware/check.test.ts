import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("the Express app uses inferloAI() and mounts the Inferlo app under /api", async () => {
  const source = readFileSync(new URL("../src/express.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/express/, "uses the Express entry point");
  assert.match(source, /inferloAI\(/, "uses the inferloAI() middleware");
  assert.match(source, /req\.ai/, "reads the AI client from the request");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return Response.json({ content: [{ type: "text", text: "Hallo Welt" }], usage: { input_tokens: 5, output_tokens: 2 } });
  }) as typeof fetch;

  const { server } = await import("../src/express.ts");
  const http = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    const res = await realFetch(`${base}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello world", to: "German" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translation: "Hallo Welt" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.model, "claude-haiku-4-5");
    assert.match(JSON.stringify(requests[0]!.body), /Hello world/);
    assert.match(JSON.stringify(requests[0]!.body), /German/);

    const health = await realFetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal((await realFetch(`${base}/api/notes`)).status, 401, "the Inferlo app's auth still applies");
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
