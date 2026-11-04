import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, InferloError, memory, mockProvider, route, type Adapter } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const quiet = () => {
  const errors: unknown[][] = [];
  return { errors, logger: { info() {}, error: (...args: unknown[]) => void errors.push(args) } };
};

function thrown(fn: () => unknown): InferloError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof InferloError);
    return error;
  }
  assert.fail("expected an error");
}

describe("health and readiness endpoints", () => {
  test("are off unless health is set", async () => {
    const app = createApp({ logger: quiet().logger });
    assert.equal((await app.request("/health")).status, 404);
    assert.equal((await app.request("/ready")).status, 404);
    assert.deepEqual(app.describe().endpoints, { openapi: "/openapi.json", mcp: false, health: false, ready: false, metrics: false });
  });

  test("GET /health answers 200 without auth and without running checks", async () => {
    let calls = 0;
    const app = createApp({ health: { checks: { slow: () => void calls++ } }, auth: { resolve: () => null }, logger: quiet().logger });
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { status: "ok" });
    assert.equal((await app.request("/health", { method: "HEAD" })).status, 200);
    assert.equal(calls, 0);
  });

  test("GET /ready checks the database, AI configuration and custom checks", async () => {
    const app = createApp({
      health: { checks: { cache: async () => {} } },
      ai: { providers: { mock: mockProvider({ respond: () => "x" }) }, models: { fast: "mock:m" } },
      logger: quiet().logger,
    });
    const res = await app.request("/ready");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.status, "ready");
    assert.deepEqual(Object.keys(body.checks).sort(), ["ai", "cache", "database"]);
    for (const check of Object.values(body.checks) as { status: string; durationMs: number }[]) {
      assert.equal(check.status, "ok");
      assert.equal(typeof check.durationMs, "number");
    }
    assert.deepEqual(app.describe().endpoints, { openapi: "/openapi.json", mcp: false, health: "/health", ready: "/ready", metrics: false });
  });

  test("a failing check answers 503 with a generic error and logs the real one", async () => {
    const { errors, logger } = quiet();
    const app = createApp({
      health: {
        checks: {
          payments: () => {
            throw new Error("connect ECONNREFUSED secret-host:5432 password=hunter2");
          },
          ok: () => {},
        },
      },
      logger,
    });
    const res = await app.request("/ready");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.payments.status, "error");
    assert.equal(body.checks.payments.error, "Check failed.");
    assert.equal(body.checks.ok.status, "ok");
    assert.equal(body.checks.database.status, "ok");
    assert.doesNotMatch(JSON.stringify(body), /hunter2|secret-host/);
    assert.ok(errors.some((e) => String(e[0]).includes("payments") && String(e[1]).includes("ECONNREFUSED")));
    // Liveness does not depend on the checks.
    assert.equal((await app.request("/health")).status, 200);
  });

  test("exposeErrors shows check error messages", async () => {
    const app = createApp({ exposeErrors: true, health: { checks: { payments: () => Promise.reject(new Error("payments down")) } }, logger: quiet().logger });
    const body = await (await app.request("/ready")).json();
    assert.equal(body.checks.payments.error, "payments down");
  });

  test("checks that take too long fail with a timeout", async () => {
    const app = createApp({ health: { timeoutMs: 20, checks: { hang: () => new Promise(() => {}) } }, logger: quiet().logger });
    const started = Date.now();
    const body = await (await app.request("/ready")).json();
    assert.ok(Date.now() - started < 1000);
    assert.equal(body.checks.hang.status, "error");
    assert.equal(body.checks.hang.error, "Timed out after 20 ms.");
  });

  test("a database that cannot be reached fails the database check", async () => {
    const broken: Adapter = { ...memory(), dialect: "broken", sql: async () => Promise.reject(new Error("no connection")) };
    const app = createApp({ db: broken, health: true, logger: quiet().logger });
    const res = await app.request("/ready");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).checks.database.status, "error");
  });

  test("AI aliases pointing to a provider that is not configured fail the ai check", async () => {
    const app = createApp({ health: true, ai: { providers: { mock: mockProvider({ respond: () => "x" }) }, models: { fast: ["mock:m", "openai:gpt-5-mini"] } }, logger: quiet().logger });
    const body = await (await app.request("/ready")).json();
    assert.equal(body.checks.ai.status, "error");
    assert.match(body.checks.ai.error, /openai/);
  });

  test("custom paths, app.checkReady() and health: true", async () => {
    const app = createApp({ health: { path: "/livez", readyPath: "/readyz" }, logger: quiet().logger });
    assert.equal((await app.request("/livez")).status, 200);
    assert.equal((await app.request("/readyz")).status, 200);
    assert.equal((await app.request("/health")).status, 404);
    const report = await app.checkReady();
    assert.equal(report.status, "ready");
    assert.deepEqual(Object.keys(report.checks), ["database"]);
    assert.equal((await createApp({ health: true, logger: quiet().logger }).request("/ready")).status, 200);
  });

  test("invalid health options raise IL6014", () => {
    const logger = quiet().logger;
    const health = route.get("/health", { auth: "public" }).handle(() => ({ ok: true }));
    const cases: unknown[] = [
      { path: "health" },
      { readyPath: "/health" },
      { checks: { db: "yes" } },
      { checks: { database: () => {} } },
      { timeoutMs: 0 },
      { path: "/openapi.json" },
    ];
    for (const option of cases) assert.equal(thrown(() => createApp({ health: option as never, logger })).code, "IL6014", JSON.stringify(option));
    const conflict = thrown(() => createApp({ health: true, routes: [health], logger }));
    assert.equal(conflict.code, "IL6014");
    assert.match(conflict.message, /GET \/health/);
  });
});

describe("readiness on PostgreSQL", { skip: !PG_URL }, () => {
  const db = PG_URL ? postgres({ url: PG_URL }) : memory();
  after(() => db.close?.());
  test("runs select 1 against the database", async () => {
    const app = createApp({ db, health: true, logger: quiet().logger });
    const body = await (await app.request("/ready")).json();
    assert.equal(body.status, "ready");
    assert.equal(body.checks.database.status, "ok");
  });
});
