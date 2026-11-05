import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as h3 from "h3";
import { aiPlugin, apiRoute } from "../src/nitro.ts";

test("the Inferlo app is served from a Nitro catch-all route under /api, and event.context.ai is set", async () => {
  const source = readFileSync(new URL("../src/nitro.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/h3/, "uses the h3 entry point");
  const hooks: ((event: any) => void)[] = [];
  (aiPlugin as any)({ hooks: { hook: (name: string, fn: (event: any) => void) => name === "request" && void hooks.push(fn) } });
  const lib = h3 as any;
  const app = new lib.H3();
  app.use((event: any) => void hooks.forEach((fn) => fn(event)));
  let sawAI = false;
  app.get("/hello", (event: any) => {
    sawAI = typeof event.context.ai?.generate === "function";
    return "nitro";
  });
  app.all("/api/**", apiRoute as any);
  const request = (path: string) => app.fetch(new Request(`http://localhost${path}`)) as Promise<Response>;
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.ok((await (await request("/api/openapi.json")).json()).paths["/notes"]);
  assert.equal((await request("/api/notes")).status, 401, "app auth still applies");
  assert.equal(await (await request("/hello")).text(), "nitro");
  assert.ok(sawAI, "event.context.ai is set for Nitro routes");
});
