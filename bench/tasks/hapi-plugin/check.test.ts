import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeServer } from "../src/hapi.ts";

test("the Inferlo app is served under /api and hapi handlers get request.ai", async () => {
  const source = readFileSync(new URL("../src/hapi.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/hapi/, "uses the hapi entry point");
  const server = await makeServer();
  const health = await server.inject("/api/health");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.payload), { status: "ok" });
  assert.ok(JSON.parse((await server.inject("/api/openapi.json")).payload).paths["/notes"], "OpenAPI of the app");
  const post = await server.inject({ method: "POST", url: "/api/notes", payload: { title: "x" } });
  assert.equal(post.statusCode, 401, "POST /notes needs sign-in");
  assert.equal(JSON.parse(post.payload).error.code, "IL3001");
  server.route({ method: "GET", path: "/ai-check", handler: (request) => ({ hasAI: typeof (request as any).ai?.generate === "function" }) });
  assert.deepEqual(JSON.parse((await server.inject("/ai-check")).payload), { hasAI: true });
});
