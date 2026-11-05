import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NextRequest } from "next/server.js";
import * as handlers from "../src/app/api/[[...path]]/route.ts";

test("every request under /api goes to the Inferlo app with /api removed", async () => {
  const source = readFileSync(new URL("../src/app/api/[[...path]]/route.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/nextjs/, "uses the Next.js entry point");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
    assert.equal(typeof handlers[method], "function", `exports ${method}`);
  }
  const health = await handlers.GET(new NextRequest("http://localhost:3000/api/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const doc = await (await handlers.GET(new NextRequest("http://localhost:3000/api/openapi.json"))).json();
  assert.ok(doc.paths["/notes"], "OpenAPI of the app");
  const post = await handlers.POST(new NextRequest("http://localhost:3000/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }));
  assert.equal(post.status, 401, "POST /notes needs sign-in");
  assert.equal((await post.json()).error.code, "IL3001");
});
