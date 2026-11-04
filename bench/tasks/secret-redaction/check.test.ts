import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

const STRIPE = "bench-stripe-secret-0123456789";

test("STRIPE_SECRET_KEY is a config secret that never reaches the logs", async () => {
  process.env.STRIPE_SECRET_KEY = STRIPE;
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.OPENAI_API_KEY = "openai-test-key";
  const { settings } = await import("../src/config.ts");
  assert.equal((settings as Record<string, unknown>).STRIPE_SECRET_KEY, STRIPE, "settings.STRIPE_SECRET_KEY reads the variable");
  assert.ok(!JSON.stringify(settings).includes(STRIPE), "hidden in JSON.stringify(settings)");
  assert.ok(!inspect(settings).includes(STRIPE), "hidden when settings are logged");

  // A model provider error that echoes the key ends up in the app's error log.
  globalThis.fetch = (async () => new Response(`upstream failed for customer key ${STRIPE}`, { status: 400 })) as typeof fetch;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "));
  try {
    const { hashToken } = await import("@browserlessapi/inferlo");
    const { app } = await import("../src/app.ts");
    const db = app.db as any;
    const user = await db.users.insert({ email: "ada@example.com", name: "Ada" });
    await db.api_keys.insert({ userId: user.id, hash: await hashToken("bench-token") });
    const note = await db.notes.insert({ title: "Invoice", body: "Due Friday", ownerId: user.id });
    const res = await app.request(`/notes/${note.id}/summary`, { method: "POST", headers: { authorization: "Bearer bench-token" } });
    assert.ok(res.status >= 500, `the summary fails (got ${res.status})`);
  } finally {
    console.error = original;
  }
  const out = logged.join("\n");
  assert.match(out, /upstream failed for customer key/, "the error was logged");
  assert.ok(!out.includes(STRIPE), `the key must not be logged:\n${out}`);
});
