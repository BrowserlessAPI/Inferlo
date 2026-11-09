import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";
import { lines } from "../src/log.ts";

test("the app's request logs go through the shared winston logger with the request id", async () => {
  const res = await app.fetch(new Request("http://localhost/notes"));
  const id = res.headers.get("x-request-id");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const entry = lines.find((e) => typeof e.message === "string" && e.message.startsWith("GET /notes ") && e.requestId === id);
  assert.ok(entry, `a winston entry for the request, got ${JSON.stringify(lines)}`);
  assert.equal(entry.service, "notes", "written by the shared logger");
  assert.equal(entry.status, res.status);
});
