import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as hooks from "../src/hooks.server.ts";
import * as handlers from "../src/routes/api/[...path]/+server.ts";

const event = (url: string, init?: RequestInit) => ({ request: new Request(url, init), getClientAddress: () => "127.0.0.1", locals: {} });

test("every request under /api goes to the Inferlo app with /api removed, and locals.ai is set", async () => {
  const source = readFileSync(new URL("../src/routes/api/[...path]/+server.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/sveltekit/, "uses the SvelteKit entry point");
  const api = handlers as Record<string, (e: unknown) => Promise<Response>>;
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "fallback"]) {
    assert.equal(typeof api[method], "function", `exports ${method}`);
  }
  const health = await api.GET!(event("http://localhost:5173/api/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const doc = await (await api.GET!(event("http://localhost:5173/api/openapi.json"))).json();
  assert.ok(doc.paths["/notes"], "OpenAPI of the app");
  const post = await api.POST!(event("http://localhost:5173/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }));
  assert.equal(post.status, 401, "POST /notes needs sign-in");

  const handle = (hooks as { handle?: (input: unknown) => Promise<Response> }).handle;
  assert.equal(typeof handle, "function", "src/hooks.server.ts exports handle");
  const locals: { ai?: { generate?: unknown } } = {};
  const res = await handle!({ event: { locals, request: new Request("http://localhost:5173/") }, resolve: async () => new Response("page") });
  assert.equal(await res.text(), "page", "the hook calls resolve");
  assert.equal(typeof locals.ai?.generate, "function", "event.locals.ai is the AI client");
});
