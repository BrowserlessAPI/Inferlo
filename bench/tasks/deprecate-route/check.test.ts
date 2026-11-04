import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("POST /notes/:id/summary is deprecated with since, sunset and link", () => {
  const summary = app.describe().routes.find((r) => r.method === "POST" && r.path === "/notes/:id/summary");
  assert.ok(summary, "the route still exists");
  assert.deepEqual(summary.deprecated, { since: "2026-11-15", sunset: "2027-03-31", link: "https://docs.example.com/notes/summaries" });
  for (const r of app.describe().routes) if (r.path !== summary.path || r.method !== summary.method) assert.equal(r.deprecated, undefined, `${r.method} ${r.path} is not deprecated`);
});

test("its responses send the Deprecation, Sunset and Link headers", async () => {
  const original = console.log;
  console.log = () => {};
  try {
    const res = await app.request("/notes/00000000-0000-4000-8000-000000000001/summary", { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("deprecation"), `@${Date.UTC(2026, 10, 15) / 1000}`);
    assert.equal(res.headers.get("sunset"), "Wed, 31 Mar 2027 00:00:00 GMT");
    assert.equal(res.headers.get("link"), '<https://docs.example.com/notes/summaries>; rel="deprecation"; type="text/html"');
  } finally {
    console.log = original;
  }
});
