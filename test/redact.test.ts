import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, test } from "node:test";
import { anthropic, config, createApp, InferloError, job, openai, route, t } from "../src/index.ts";
import { createRedactor, REDACTED } from "../src/redact.ts";

const capture = () => {
  const lines: string[] = [];
  const logged: unknown[] = [];
  const push = (message: string, data?: unknown) => {
    logged.push(data);
    lines.push(`${message} ${data === undefined ? "" : inspect(data, { depth: 10 })}`);
  };
  return { lines, logged, logger: { info: push, error: push }, text: () => lines.join("\n") };
};

describe("secret redaction in logs", () => {
  test("credentials in thrown errors are redacted, and the logged value is still an Error", async () => {
    const log = capture();
    const app = createApp({
      logger: log.logger,
      routes: [route.get("/boom", { auth: "public" }).handle(() => {
        throw new Error("call failed with Authorization: Bearer abc.def.ghi-123 to postgres://app:hunter2secret@db.internal:5432/app?sslmode=require and https://x.test/cb?token=tok_9f8e7d6c&page=2");
      })],
    });
    const res = await app.request("/boom");
    assert.equal(res.status, 500);
    const out = log.text();
    for (const secret of ["abc.def.ghi-123", "hunter2secret", "tok_9f8e7d6c"]) assert.ok(!out.includes(secret), `${secret} must not be logged:\n${out}`);
    assert.match(out, /Bearer \[redacted\]/);
    assert.match(out, /postgres:\/\/app:\[redacted\]@db\.internal/);
    assert.match(out, /token=\[redacted\]&page=2/);
    const error = log.logged.find((d) => d instanceof Error) as Error;
    assert.ok(error, "an Error is logged");
    assert.ok(error.stack && !error.stack.includes("hunter2secret"));
  });

  test("AI provider API keys never appear in logged errors, also in a provider's error body", async () => {
    const log = capture();
    const openaiKey = "sk-proj-0123456789abcdefABCDEF";
    const anthropicKey = "plain-anthropic-secret-42";
    const fetch = async (url: string | URL | Request) => {
      const key = String(url).includes("anthropic") ? anthropicKey : openaiKey;
      return new Response(`{"error":{"message":"Incorrect API key provided: ${key}"}}`, { status: 401 });
    };
    const app = createApp({
      logger: log.logger,
      ai: {
        providers: { openai: openai({ apiKey: openaiKey, fetch }), anthropic: anthropic({ apiKey: anthropicKey, fetch }) },
        models: { fast: "openai:gpt-5-mini", smart: "anthropic:claude-sonnet-4-5" },
      },
      routes: [
        route.get("/fast", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "fast", prompt: "hi" })).text),
        route.get("/smart", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "smart", prompt: "hi" })).text),
      ],
    });
    assert.ok((await app.request("/fast")).status >= 500);
    assert.ok((await app.request("/smart")).status >= 500);
    const out = log.text();
    assert.ok(out.includes("Incorrect API key provided"), out);
    assert.ok(!out.includes(openaiKey), out);
    assert.ok(!out.includes(anthropicKey), out);
  });

  test("config() secrets passed to createApp({ redact }) are replaced, other values are not", async () => {
    const log = capture();
    const previous = { WEBHOOK_SECRET: process.env.WEBHOOK_SECRET, APP_REGION: process.env.APP_REGION };
    process.env.WEBHOOK_SECRET = "whsec_live_7Hk2pQ";
    process.env.APP_REGION = "eu-west-1";
    try {
      const settings = config({ schema: t.object({ WEBHOOK_SECRET: t.string(), APP_REGION: t.string() }), secrets: ["WEBHOOK_SECRET"] });
      const app = createApp({
        logger: log.logger,
        redact: [settings, "extra-value-to-hide", undefined],
        routes: [route.get("/hook", { auth: "public" }).handle(() => {
          throw new Error(`signature check with ${settings.WEBHOOK_SECRET} in ${settings.APP_REGION} failed, extra-value-to-hide`);
        })],
      });
      await app.request("/hook");
      const out = log.text();
      assert.ok(!out.includes("whsec_live_7Hk2pQ"), out);
      assert.ok(!out.includes("extra-value-to-hide"), out);
      assert.ok(out.includes("eu-west-1"), "values that are not secret stay");
    } finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("exposeErrors shows redacted messages to clients", async () => {
    const app = createApp({
      exposeErrors: true,
      logger: capture().logger,
      redact: ["internal-db-password-1"],
      routes: [route.get("/x", { auth: "public" }).handle(() => {
        throw new Error("login as admin with internal-db-password-1 failed");
      })],
    });
    const body = await (await app.request("/x")).json();
    assert.equal(body.error.message, `login as admin with ${REDACTED} failed`);
  });

  test("failing jobs are logged with redacted errors", async () => {
    const log = capture();
    const failing = job("call-api", { input: t.object({}), retries: 0 }).handle(async () => {
      throw new Error("upstream said: invalid api-key: k_live_abcdef123456");
    });
    const app = createApp({ logger: log.logger, jobs: [failing] });
    await app.jobs.enqueue(failing, {});
    await app.jobs.runDue();
    const out = log.text();
    assert.match(out, /call-api/);
    assert.ok(!out.includes("k_live_abcdef123456"), out);
  });

  test("invalid redact options raise IL6018", () => {
    for (const bad of ["secret", [42], [{ not: "a config" }], [() => "x"]]) {
      assert.throws(() => createApp({ redact: bad as never }), (e: InferloError) => e.code === "IL6018");
    }
  });
});

describe("createRedactor", () => {
  const r = createRedactor(["s3cr3t-value"]);

  test("redacts sensitive keys in objects and headers, and leaves other data alone", () => {
    const input = {
      headers: new Headers({ authorization: "Bearer xyz123456", cookie: "sid=abc; theme=dark", accept: "application/json" }),
      nested: { password: "pw-123456", apiKey: "k", token: "", user: { id: "u1", name: "Ada" } },
      list: ["note s3cr3t-value", 3, null],
      at: new Date(0),
    };
    const out = r.value(input) as any;
    assert.deepEqual(out.headers, { accept: "application/json", authorization: REDACTED, cookie: REDACTED });
    assert.equal(out.nested.password, REDACTED);
    assert.equal(out.nested.apiKey, REDACTED);
    assert.equal(out.nested.token, "", "empty values stay empty");
    assert.deepEqual(out.nested.user, { id: "u1", name: "Ada" });
    assert.deepEqual(out.list, [`note ${REDACTED}`, 3, null]);
    assert.ok(out.at instanceof Date);
    // The input is not changed.
    assert.equal(input.nested.password, "pw-123456");
  });

  test("keeps InferloError fields and redacts causes", () => {
    const error = new InferloError("IL9999", "failed with Cookie: session=abcdef", { status: 502, details: { authorization: "Basic dXNlcjpwYXNz" }, cause: new Error("sk-ant-api03-ABCDEFGHIJKLMNOPQRST") });
    const out = r.value(error) as InferloError;
    assert.ok(out instanceof InferloError);
    assert.equal(out.code, "IL9999");
    assert.equal(out.status, 502);
    assert.equal(out.message, `failed with Cookie: ${REDACTED}`);
    assert.deepEqual(out.details, { authorization: REDACTED });
    assert.equal((out.cause as Error).message, REDACTED);
    assert.equal(error.message, "failed with Cookie: session=abcdef", "the original error is not changed");
  });

  test("handles cycles and common key formats", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = r.value(a) as Record<string, unknown>;
    assert.equal(out.self, out);
    assert.equal(r.text("key AIzaSyA1234567890abcdefghijklmnopqrstu"), `key ${REDACTED}`);
    assert.equal(r.text("gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789"), `gh token ${REDACTED}`);
    assert.equal(r.text('{"x-api-key":"abc123"}'), `{"x-api-key":"${REDACTED}"}`);
    assert.equal(r.text("plain text without secrets"), "plain text without secrets");
  });
});
