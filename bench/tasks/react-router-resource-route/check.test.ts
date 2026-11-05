import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createStaticHandler } from "react-router";
import * as api from "../src/routes/api.ts";

test("every request under /api goes to the Inferlo app with /api removed", async () => {
  const source = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/react-router/, "uses the React Router entry point");
  const mod = api as Record<string, any>;
  assert.equal(typeof mod.loader, "function", "exports loader");
  assert.equal(typeof mod.action, "function", "exports action");
  const handler = createStaticHandler([{ id: "api", path: "/api/*", loader: mod.loader, action: mod.action }]);
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return (await handler.queryRoute(new Request(url, init))) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };
  const health = await request("http://localhost:5173/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.ok((await (await request("http://localhost:5173/api/openapi.json")).json()).paths["/notes"], "OpenAPI of the app");
  const post = await request("http://localhost:5173/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
  assert.equal(post.status, 401, "POST /notes needs sign-in");
  assert.equal((await post.json()).error.code, "IL3001");
});
