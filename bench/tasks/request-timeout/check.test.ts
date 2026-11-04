import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("routes time out after 15 seconds, the AI summary route after 2 minutes", () => {
  const d = app.describe();
  assert.equal(d.requestTimeoutMs, 15_000);
  for (const r of d.routes) {
    if (r.method === "POST" && r.path === "/notes/:id/summary") assert.equal(r.timeoutMs, 120_000, "summary route");
    else assert.equal(r.timeoutMs, undefined, `${r.method} ${r.path} keeps the app-wide limit`);
  }
});
