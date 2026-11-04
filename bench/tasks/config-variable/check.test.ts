import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

// A new module instance reads the environment again.
const fresh = (tag: string): Promise<{ settings: unknown }> => import(new URL(`../src/config.ts?${tag}`, import.meta.url).href);

test("SUPPORT_EMAIL and STRIPE_SECRET_KEY are validated configuration, and GET /support uses it", async () => {
  process.env.SUPPORT_EMAIL = "help@acme.io";
  process.env.STRIPE_SECRET_KEY = "sk_live_bench_secret_value";
  const { settings } = await import("../src/config.ts");
  assert.equal((settings as Record<string, unknown>).SUPPORT_EMAIL, "help@acme.io");
  assert.equal((settings as Record<string, unknown>).STRIPE_SECRET_KEY, "sk_live_bench_secret_value");
  assert.doesNotMatch(JSON.stringify(settings), /sk_live_bench_secret_value/, "the secret is redacted in JSON");
  assert.doesNotMatch(inspect(settings), /sk_live_bench_secret_value/, "the secret is redacted in console.log");

  const { app } = await import("../src/app.ts");
  const res = await app.request("/support");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "help@acme.io" });

  process.env.SUPPORT_EMAIL = "not-an-email";
  await assert.rejects(fresh("invalid-email"), (e: { code?: string }) => e.code === "IL7003");
  delete process.env.SUPPORT_EMAIL;
  await assert.rejects(fresh("missing-email"), (e: { code?: string }) => e.code === "IL7003");
  delete process.env.STRIPE_SECRET_KEY;
  process.env.SUPPORT_EMAIL = "help@acme.io";
  const optional = await fresh("no-stripe");
  assert.equal((optional.settings as Record<string, unknown>).STRIPE_SECRET_KEY, undefined, "STRIPE_SECRET_KEY is optional");
});
