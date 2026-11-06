import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

const file = new URL("../netlify/functions/api.ts", import.meta.url);

test("netlify/functions/api.ts serves the whole app for every path, with Netlify's context", async () => {
  assert.ok(existsSync(file), "netlify/functions/api.ts must exist");
  const mod = (await import(file.href)) as { default?: unknown; config?: { path?: string | string[] } };
  assert.equal(typeof mod.default, "function", "Netlify Functions 2.0 call a default-exported function with (request, context)");
  const paths = [mod.config?.path ?? []].flat();
  assert.ok(paths.includes("/*"), 'config.path must route every path to the function ("/*")');

  const handler = mod.default as (req: Request, context: unknown) => Promise<Response>;
  let ipRead = false;
  const context = {
    get ip() {
      ipRead = true;
      return "203.0.113.7";
    },
    requestId: "01JNETLIFYREQUEST",
    geo: {},
    params: {},
    waitUntil: () => {},
  };
  const health = await handler(new Request("https://notes.netlify.app/health"), context);
  assert.equal(health.status, 200);
  assert.ok(ipRead, "the Netlify context (with the client address in context.ip) must reach the app");
  const openapi = await handler(new Request("https://notes.netlify.app/openapi.json"), context);
  assert.equal(openapi.status, 200);
  assert.ok(((await openapi.json()) as { paths: Record<string, unknown> }).paths["/notes"]);
});
