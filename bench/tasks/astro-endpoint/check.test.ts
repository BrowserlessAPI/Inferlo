import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import * as middleware from "../src/middleware.ts";
import * as endpoint from "../src/pages/api/[...path].ts";

test("every request under /api goes to the Inferlo app with /api removed, and locals.ai is set", async () => {
  const source = readFileSync(new URL("../src/pages/api/[...path].ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/astro/, "uses the Astro entry point");
  assert.equal((endpoint as { prerender?: unknown }).prerender, false, "the endpoint runs on the server");
  const container = await AstroContainer.create();
  const render = (url: string, init?: RequestInit) => container.renderToResponse(endpoint as never, { routeType: "endpoint", request: new Request(url, init), locals: {} } as never);
  for (const method of ["DELETE", "PATCH", "OPTIONS"]) {
    assert.notEqual((await render("http://localhost:4321/api/notes", { method })).status, 404, `${method} reaches the app`);
  }
  const health = await render("http://localhost:4321/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const doc = await (await render("http://localhost:4321/api/openapi.json")).json();
  assert.ok(doc.paths["/notes"], "OpenAPI of the app");
  const post = await render("http://localhost:4321/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
  assert.equal(post.status, 401, "POST /notes needs sign-in");

  const onRequest = (middleware as { onRequest?: (context: unknown, next: () => Promise<Response>) => Promise<Response> }).onRequest;
  assert.equal(typeof onRequest, "function", "src/middleware.ts exports onRequest");
  const locals: { ai?: { generate?: unknown } } = {};
  const res = await onRequest!({ locals, request: new Request("http://localhost:4321/") }, async () => new Response("page"));
  assert.equal(await res.text(), "page", "the middleware calls next");
  assert.equal(typeof locals.ai?.generate, "function", "context.locals.ai is the AI client");
});
