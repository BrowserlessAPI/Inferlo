import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { verifyWebhook } from "../src/webhook.ts";

const logger = { info() {}, error() {} };
const now = () => Math.floor(Date.now() / 1000);
const isError = (code: string, pattern?: RegExp) => (error: unknown) => error instanceof InferloError && error.code === code && (!pattern || pattern.test(error.message));

// Signatures are computed here with node:crypto, independently of Inferlo's Web Crypto implementation.
const stripeHeader = (secret: string, body: string, t = now()) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const githubHeader = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const standardHeaders = (secret: string, body: string, id = "msg_1", t = now()) => ({
  "webhook-id": id,
  "webhook-timestamp": String(t),
  "webhook-signature": `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${t}.${body}`).digest("base64")}`,
});

const STRIPE_SECRET = "whsec_stripe_test_secret_123";
const GITHUB_SECRET = "It's a Secret to Everybody";
const STANDARD_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const received: unknown[] = [];
const stripe = route.post("/webhooks/stripe", { auth: "public", webhook: { scheme: "stripe", secret: [STRIPE_SECRET, "whsec_new_secret"] }, body: t.object({ id: t.string(), type: t.string() }).strip() }).handle(({ body }) => {
  received.push(body);
  return { received: true };
});
const github = route.post("/webhooks/github", { auth: "public", webhook: { scheme: "github", secret: GITHUB_SECRET } }).handle(() => ({ ok: true }));
const standard = route.post("/webhooks/clerk", { auth: "public", webhook: { scheme: "standard", secret: STANDARD_SECRET, toleranceMs: 60_000 }, body: t.object({ type: t.string() }) }).handle(({ body }) => ({ type: body.type }));
const app = createApp({ routes: [{ stripe, github, standard }], logger });

const post = (path: string, body: string, headers: Record<string, string>) => app.fetch(new Request(`http://localhost${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));

describe("webhook signatures", () => {
  test("Stripe: a signed event reaches the handler with its validated body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const res = await post("/webhooks/stripe", body, { "stripe-signature": stripeHeader(STRIPE_SECRET, body) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    assert.deepEqual(received.at(-1), { id: "evt_1", type: "invoice.paid" });
  });

  test("Stripe: rotated secrets, several v1 signatures, wrong secrets, changed bodies and old timestamps", async () => {
    const body = JSON.stringify({ id: "evt_2", type: "invoice.paid" });
    assert.equal((await post("/webhooks/stripe", body, { "stripe-signature": stripeHeader("whsec_new_secret", body) })).status, 200, "second secret");
    const both = `${stripeHeader("whsec_wrong", body)},v1=${stripeHeader(STRIPE_SECRET, body).split("v1=")[1]}`;
    assert.equal((await post("/webhooks/stripe", body, { "stripe-signature": both })).status, 200, "any v1 signature may match");
    const before = received.length;
    for (const header of [stripeHeader("whsec_wrong", body), stripeHeader(STRIPE_SECRET, body + " "), stripeHeader(STRIPE_SECRET, body, now() - 301), stripeHeader(STRIPE_SECRET, body, now() + 301), `t=${now()}`, "v1=abc", "", "t=abc,v1=00"]) {
      const res = await post("/webhooks/stripe", body, header ? { "stripe-signature": header } : {});
      assert.equal(res.status, 401, header);
      const error = (await res.json()).error;
      assert.equal(error.code, "IL3012", header);
    }
    const changed = JSON.stringify({ id: "evt_2", type: "invoice.voided" });
    assert.equal((await post("/webhooks/stripe", changed, { "stripe-signature": stripeHeader(STRIPE_SECRET, body) })).status, 401, "a body changed after signing");
    assert.equal(received.length, before, "the handler never ran");
  });

  test("GitHub: the example from GitHub's docs verifies, anything else is refused", async () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    assert.equal(githubHeader(GITHUB_SECRET, "Hello, World!"), "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
    const res = await post("/webhooks/github", "Hello, World!", { "content-type": "text/plain", "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" });
    assert.equal(res.status, 200);
    const body = JSON.stringify({ action: "opened" });
    assert.equal((await post("/webhooks/github", body, { "x-hub-signature-256": githubHeader(GITHUB_SECRET, body) })).status, 200);
    for (const header of [githubHeader("other", body), githubHeader(GITHUB_SECRET, "{}"), githubHeader(GITHUB_SECRET, body).replace("sha256=", "sha1="), "sha256=zz", ""]) {
      const res = await post("/webhooks/github", body, header ? { "x-hub-signature-256": header } : {});
      assert.equal(res.status, 401, header);
      assert.equal((await res.json()).error.code, "IL3012");
    }
  });

  test("Standard Webhooks: the specification's example signature verifies", async () => {
    // https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
    const headers = new Headers({ "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek", "webhook-timestamp": "1614265330", "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" });
    await verifyWebhook(standard.options.webhook!, headers, '{"test": 2432232314}', 1614265330 * 1000);
    await assert.rejects(verifyWebhook(standard.options.webhook!, headers, '{"test": 2432232315}', 1614265330 * 1000), isError("IL3012"));
    await assert.rejects(verifyWebhook(standard.options.webhook!, headers, '{"test": 2432232314}', (1614265330 + 61) * 1000), isError("IL3012", /too old/));
  });

  test("Standard Webhooks: signed requests pass, several signatures are accepted, others are refused", async () => {
    const body = JSON.stringify({ type: "user.created" });
    const res = await post("/webhooks/clerk", body, standardHeaders(STANDARD_SECRET, body));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: "user.created" });
    const signed = standardHeaders(STANDARD_SECRET, body);
    assert.equal((await post("/webhooks/clerk", body, { ...signed, "webhook-signature": `v1,AAAA ${signed["webhook-signature"]}` })).status, 200);
    for (const headers of [
      standardHeaders("whsec_" + Buffer.from("other key").toString("base64"), body),
      { ...signed, "webhook-id": "msg_other" },
      standardHeaders(STANDARD_SECRET, body, "msg_old", now() - 120),
      { ...signed, "webhook-signature": signed["webhook-signature"].replace("v1,", "v2,") },
      { "webhook-timestamp": signed["webhook-timestamp"], "webhook-signature": signed["webhook-signature"] },
    ]) {
      const res = await post("/webhooks/clerk", body, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal((await res.json()).error.code, "IL3012");
    }
  });

  test("the signature is checked before the body is validated, so unsigned requests learn nothing about the schema", async () => {
    const res = await post("/webhooks/stripe", "not json", {});
    assert.equal(res.status, 401);
    const signed = await post("/webhooks/stripe", "not json", { "stripe-signature": stripeHeader(STRIPE_SECRET, "not json") });
    assert.equal(signed.status, 400, "signed but invalid JSON");
  });

  test("describe() shows the webhook scheme, never the secret", () => {
    const routes = app.describe().routes;
    assert.equal(routes.find((r) => r.path === "/webhooks/stripe")?.webhook, "stripe");
    assert.equal(routes.find((r) => r.path === "/webhooks/github")?.webhook, "github");
    assert.doesNotMatch(JSON.stringify(app.describe()), /whsec_|Secret to Everybody/);
  });

  test("invalid webhook options raise IL6066 at startup", () => {
    const make = (options: Record<string, unknown>, method: "post" | "get" = "post") => () =>
      createApp({ routes: [(route as any)[method]("/hook", { auth: "public", ...options }).handle(() => ({}))], auth: bearer(() => null), logger });
    for (const [options, pattern] of [
      [{ webhook: { scheme: "paypal", secret: "x" } }, /scheme/],
      [{ webhook: { scheme: "stripe", secret: undefined } }, /environment variable/],
      [{ webhook: { scheme: "stripe", secret: "" } }, /secret/],
      [{ webhook: { scheme: "stripe", secret: [] } }, /secret/],
      [{ webhook: { scheme: "standard", secret: "whsec_!!!" } }, /whsec_/],
      [{ webhook: { scheme: "github", secret: "x", toleranceMs: 1000 } }, /GitHub/],
      [{ webhook: { scheme: "stripe", secret: "x", toleranceMs: 10 } }, /toleranceMs/],
      [{ webhook: { scheme: "stripe", secret: "x", extra: 1 } }, /unknown option/],
      [{ webhook: "stripe" }, /scheme, secret/],
      [{ webhook: { scheme: "stripe", secret: "x" }, auth: "user" }, /auth: "public"/],
      [{ webhook: { scheme: "stripe", secret: "x" }, tool: true }, /AI tool/],
    ] as const) {
      assert.throws(make(options as Record<string, unknown>), isError("IL6066", pattern), JSON.stringify(options));
    }
    assert.throws(make({ webhook: { scheme: "stripe", secret: "x" } }, "get"), isError("IL6066", /POST, PUT and PATCH/));
  });
});
