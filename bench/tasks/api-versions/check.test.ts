import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("the notes routes are API version v1 under /v1", () => {
  const d = app.describe();
  assert.deepEqual(d.versions, [{ name: "v1", openapi: "/v1/openapi.json" }]);
  const notes = d.routes.filter((r) => r.path.includes("/notes"));
  assert.ok(notes.length >= 5, "every notes route is still there");
  for (const r of notes) {
    assert.ok(r.path.startsWith("/v1/notes"), `${r.method} ${r.path} is under /v1`);
    assert.equal(r.version, "v1");
  }
});

test("version v1 has its own OpenAPI document and the old paths are gone", async () => {
  const original = console.log;
  console.log = () => {};
  try {
    const doc = await app.request("/v1/openapi.json");
    assert.equal(doc.status, 200);
    const paths = Object.keys(((await doc.json()) as { paths: Record<string, unknown> }).paths);
    assert.ok(paths.includes("/v1/notes") && paths.includes("/v1/notes/{id}"));
    assert.equal((await app.request("/v1/notes")).status, 401, "auth still applies");
    assert.equal((await app.request("/notes")).status, 404);
  } finally {
    console.log = original;
  }
});
