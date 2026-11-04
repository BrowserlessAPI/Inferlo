import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { IgnitorFactory } from "@adonisjs/core/factories";

test("the AdonisJS app gets ctx.ai from Inferlo's provider and config/ai.ts", async () => {
  const rcSource = readFileSync(new URL("../src/adonis/adonisrc.ts", import.meta.url), "utf8");
  assert.match(rcSource, /@browserlessapi\/inferlo\/adonisjs/, "registers the Inferlo provider");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
    requests.push(JSON.parse(String(init!.body)));
    return Response.json({ content: [{ type: "text", text: "Hallo Welt" }], usage: { input_tokens: 5, output_tokens: 2 } });
  }) as typeof fetch;

  const rc = (await import("../src/adonis/adonisrc.ts")).default;
  const ai = (await import("../src/adonis/config/ai.ts")).default;
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .merge({ rcFileContents: rc as Record<string, unknown>, config: { ai } })
    .create(new URL("../src/adonis/", import.meta.url), { importer: (path) => import(path) });
  const app = ignitor.createApp("web");
  await app.init();
  await app.boot();
  await app.start(async () => {});
  const server = await app.container.make("server");
  await server.boot();
  const http = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const res = await realFetch(`${base}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello world", to: "German" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { translation: "Hallo Welt" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "claude-haiku-4-5");
    assert.match(JSON.stringify(requests[0]), /Hello world/);
    assert.match(JSON.stringify(requests[0]), /German/);
  } finally {
    http.close();
    await app.terminate();
  }
});
