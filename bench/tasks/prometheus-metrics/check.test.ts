import assert from "node:assert/strict";
import { test } from "node:test";

const TOKEN = "bench-metrics-token-0123456789";

test("the app refuses to start without METRICS_TOKEN", async () => {
  delete process.env.METRICS_TOKEN;
  // A separate copy of src/config.ts, read without the variable.
  const fresh: string = "../src/config.ts?without-token";
  await assert.rejects(import(fresh));
});

test("GET /internal/metrics serves Prometheus metrics to requests with the token", async () => {
  process.env.METRICS_TOKEN = TOKEN;
  const { app } = await import("../src/app.ts");
  assert.equal(app.describe().endpoints.metrics, "/internal/metrics");
  const original = console.log;
  console.log = () => {};
  try {
    assert.equal((await app.request("/internal/metrics")).status, 401);
    assert.equal((await app.request("/internal/metrics", { headers: { authorization: "Bearer wrong-token-0123456789" } })).status, 401);
    await app.request("/notes");
    const res = await app.request("/internal/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /inferlo_http_requests_total\{method="GET",route="\/notes",status="401"\} 1/);
  } finally {
    console.log = original;
  }
});
