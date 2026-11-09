import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

process.env.STRIPE_WEBHOOK_SECRET = "whsec_bench_secret_1234567890";
const { app } = await import("../src/app.ts");

const sign = (body: string, secret = process.env.STRIPE_WEBHOOK_SECRET!, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const send = (body: string, signature?: string) =>
  app.fetch(new Request("http://localhost/webhooks/stripe", { method: "POST", body, headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) } }));

test("signed Stripe events are accepted and anything else is refused", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
  const ok = await send(body, sign(body));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { received: true });
  for (const signature of [undefined, sign(body, "whsec_other"), sign(body, undefined, Math.floor(Date.now() / 1000) - 3600)]) {
    const res = await send(body, signature);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "IL3012");
  }
  const invalid = JSON.stringify({ id: 1 });
  assert.equal((await send(invalid, sign(invalid))).status, 422, "the event is validated");
  assert.equal(app.describe().routes.find((r) => r.path === "/webhooks/stripe")?.webhook, "stripe");
});
