import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";
import { captured } from "../src/sentry.ts";

test("a 500 answer is reported to Sentry with the route and request id", async () => {
  const res = await app.fetch(new Request("http://localhost/reports/monthly"));
  assert.equal(res.status, 500);
  for (let i = 0; i < 100 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(captured.length, 1, "one Sentry event");
  const event = captured[0]!;
  assert.equal(event.exception?.values?.at(-1)?.value, "report service unavailable");
  assert.equal(event.tags?.["inferlo.route"], "/reports/monthly");
  assert.equal(event.tags?.request_id, res.headers.get("x-request-id"));
});
