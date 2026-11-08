import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Route } from "../src/routes/api/$.ts";

test("every request under /api goes to the Inferlo app with /api removed", async () => {
  const source = readFileSync(new URL("../src/routes/api/$.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/tanstack-start/, "uses the TanStack Start entry point");
  const handlers = (Route as any).options?.server?.handlers;
  assert.ok(handlers && typeof handlers === "object", "the route has server.handlers");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(typeof handlers[method], "function", `handles ${method}`);
  const request = (url: string, init?: RequestInit): Promise<Response> => handlers[init?.method ?? "GET"]({ request: new Request(url, init), params: {}, context: {}, pathname: "/api/$" });
  const health = await request("http://localhost:3000/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.ok((await (await request("http://localhost:3000/api/openapi.json")).json()).paths["/notes"], "OpenAPI of the app");
  const post = await request("http://localhost:3000/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
  assert.equal(post.status, 401, "POST /notes needs sign-in");
  assert.equal((await post.json()).error.code, "IL3001");
});
