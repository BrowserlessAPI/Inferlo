import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createApp, httpError, InferloError, route, type Logger, type LogFields } from "../src/index.ts";

type Entry = { level: "info" | "error"; message: string; data: unknown; fields: LogFields | undefined };

function capture(): { entries: Entry[]; logger: Logger } {
  const entries: Entry[] = [];
  return {
    entries,
    logger: {
      info: (message, data, fields) => void entries.push({ level: "info", message, data, fields }),
      error: (message, data, fields) => void entries.push({ level: "error", message, data, fields }),
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const hello = route.get("/hello", { auth: "public" }).handle(({ requestId }) => ({ requestId }));
const boom = route.get("/boom", { auth: "public" }).handle(() => {
  throw new Error("Connection failed: Authorization: Bearer sk-live-secret-token-123");
});
const missing = route.get("/missing", { auth: "public" }).handle(() => {
  throw httpError(404, "No such thing.");
});
const own = route.get("/own", { auth: "public" }).handle(({ header }) => {
  header("X-Request-Id", "set-by-handler");
  return { ok: true };
});
const redirect = route.get("/go", { auth: "public" }).handle(() => Response.redirect("https://example.com/", 302));

describe("request ids", () => {
  test("every response has an X-Request-Id that the handler sees as ctx.requestId", async () => {
    const app = createApp({ routes: [{ hello }], logger: capture().logger });
    const first = await app.request("/hello");
    const id = first.headers.get("x-request-id")!;
    assert.match(id, UUID);
    assert.deepEqual(await first.json(), { requestId: id });
    const second = await app.request("/hello");
    assert.notEqual(second.headers.get("x-request-id"), id);
    // Errors, 404s and responses with immutable headers have one too.
    assert.match((await app.request("/nope")).headers.get("x-request-id")!, UUID);
    const app2 = createApp({ routes: [{ redirect, own }], logger: capture().logger });
    const moved = await app2.request("/go");
    assert.equal(moved.status, 302);
    assert.match(moved.headers.get("x-request-id")!, UUID);
    assert.equal((await app2.request("/own")).headers.get("x-request-id"), "set-by-handler");
  });

  test("middleware gets the request id", async () => {
    const seen: string[] = [];
    const app = createApp({ routes: [{ hello }], logger: capture().logger, middleware: [async (ctx, next) => (seen.push(ctx.requestId), next())] });
    const res = await app.request("/hello");
    assert.deepEqual(seen, [res.headers.get("x-request-id")]);
  });

  test("an incoming X-Request-Id is kept only behind a trusted proxy, and only when it is a safe value", async () => {
    const untrusted = createApp({ routes: [{ hello }], logger: capture().logger });
    const ignored = await untrusted.request("/hello", { headers: { "x-request-id": "from-client-1" } });
    assert.match(ignored.headers.get("x-request-id")!, UUID);

    const trusted = createApp({ routes: [{ hello }], logger: capture().logger, trustProxy: true });
    const kept = await trusted.request("/hello", { headers: { "x-request-id": "lb-7f3a:9.1_x-2" } });
    assert.equal(kept.headers.get("x-request-id"), "lb-7f3a:9.1_x-2");
    assert.deepEqual(await kept.json(), { requestId: "lb-7f3a:9.1_x-2" });
    for (const bad of ["has space", "a".repeat(129), "quote\"d", "semi;colon"]) {
      const res = await trusted.request("/hello", { headers: { "x-request-id": bad } });
      assert.match(res.headers.get("x-request-id")!, UUID, bad);
    }
  });
});

describe("request logs", () => {
  test("requests: true logs method, path, status, duration and request id for every request but health checks", async () => {
    const { entries, logger } = capture();
    const app = createApp({ routes: [{ hello, missing }], logger, logging: { requests: true }, health: true });
    const res = await app.request("/hello?secret=1");
    await app.request("/missing");
    await app.request("/health");
    await app.request("/ready");
    assert.equal(entries.length, 2);
    const [ok, notFound] = entries;
    assert.equal(ok!.level, "info");
    assert.match(ok!.message, /^GET \/hello 200 \d+(\.\d)?ms$/);
    assert.equal(ok!.data, undefined);
    assert.equal(ok!.fields!.requestId, res.headers.get("x-request-id"));
    assert.equal(ok!.fields!.method, "GET");
    assert.equal(ok!.fields!.path, "/hello");
    assert.equal(ok!.fields!.status, 200);
    assert.equal(typeof ok!.fields!.durationMs, "number");
    assert.equal(notFound!.fields!.status, 404);
  });

  test("request logs are off by default, and failed requests are logged with their request id", async () => {
    const { entries, logger } = capture();
    const app = createApp({ routes: [{ hello, boom }], logger });
    await app.request("/hello");
    assert.equal(entries.length, 0);
    const res = await app.request("/boom");
    assert.equal(res.status, 500);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, "error");
    assert.equal(entries[0]!.message, "GET /boom failed");
    assert.deepEqual(entries[0]!.fields, { requestId: res.headers.get("x-request-id") });
    assert.doesNotMatch(String((entries[0]!.data as Error).message), /sk-live-secret-token-123/);
  });
});

describe("built-in logger formats", () => {
  const original = { log: console.log, error: console.error };
  let lines: { stream: "out" | "err"; args: unknown[] }[] = [];
  const intercept = () => {
    lines = [];
    console.log = (...args: unknown[]) => void lines.push({ stream: "out", args });
    console.error = (...args: unknown[]) => void lines.push({ stream: "err", args });
  };
  afterEach(() => {
    console.log = original.log;
    console.error = original.error;
  });

  test('format: "json" writes one JSON object per line, with fields and errors as JSON and secrets redacted', async () => {
    const app = createApp({ name: "billing", routes: [{ hello, boom }], logging: { format: "json", requests: true } });
    intercept();
    const ok = await app.request("/hello");
    const failed = await app.request("/boom");
    console.log = original.log;
    console.error = original.error;
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal(line.args.length, 1);
    const [access, error, access2] = lines.map((line) => JSON.parse(line.args[0] as string));
    assert.equal(lines[0]!.stream, "out");
    assert.equal(lines[1]!.stream, "err");
    assert.match(access.time, /^\d{4}-\d\d-\d\dT/);
    assert.equal(access.level, "info");
    assert.equal(access.app, "billing");
    assert.match(access.msg, /^GET \/hello 200 /);
    assert.equal(access.requestId, ok.headers.get("x-request-id"));
    assert.equal(access.status, 200);
    assert.equal(access.path, "/hello");
    assert.equal(error.level, "error");
    assert.equal(error.msg, "GET /boom failed");
    assert.equal(error.requestId, failed.headers.get("x-request-id"));
    assert.equal(error.error.name, "Error");
    assert.match(error.error.message, /Authorization: Bearer \[redacted\]/);
    assert.match(error.error.stack, /logging\.test\.ts/);
    assert.doesNotMatch(lines[1]!.args[0] as string, /sk-live-secret-token-123/);
    assert.equal(access2.status, 500);
  });

  test("JSON errors keep their code, status and cause", async () => {
    const failing = route.get("/db", { auth: "public" }).handle(() => {
      throw new InferloError("IL4999", "Database unavailable.", { status: 503, expose: false, cause: new Error("ECONNREFUSED") });
    });
    const app = createApp({ routes: [{ failing }], logging: { format: "json" } });
    intercept();
    await app.request("/db");
    console.error = original.error;
    const entry = JSON.parse(lines[0]!.args[0] as string);
    assert.match(entry.msg, /^GET \/db failed: IL4999/);
    assert.equal(entry.error.message, "ECONNREFUSED");
  });

  test('format: "text" (default) adds the request id to the line', async () => {
    const app = createApp({ routes: [{ hello }], logging: { requests: true } });
    intercept();
    const res = await app.request("/hello");
    console.log = original.log;
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.args[0] as string, new RegExp(`^\\[inferlo\\] GET /hello 200 \\d+(\\.\\d)?ms \\(request ${res.headers.get("x-request-id")}\\)$`));
  });
});

describe("logging options", () => {
  test("describe() shows the logging setup", () => {
    assert.deepEqual(createApp({ logger: capture().logger }).describe().logging, { format: "custom", requests: false });
    assert.deepEqual(createApp({ logging: { format: "json", requests: true } }).describe().logging, { format: "json", requests: true });
    assert.deepEqual(createApp().describe().logging, { format: "text", requests: false });
  });

  test("invalid options raise IL6019", () => {
    const cases: [unknown, RegExp, boolean?][] = [
      ["json", /must be an object/],
      [{ format: "xml" }, /format must be "text" or "json"/],
      [{ requests: "yes" }, /requests must be true or false/],
      [{ level: "debug" }, /unknown option "level"/],
      [{ format: "json" }, /format only applies to the built-in logger/, true],
    ];
    for (const [logging, message, withLogger] of cases) {
      assert.throws(
        () => createApp({ logging: logging as never, ...(withLogger ? { logger: capture().logger } : {}) }),
        (e: unknown) => e instanceof InferloError && e.code === "IL6019" && message.test(e.message),
        String(message),
      );
    }
    // requests with your own logger is fine.
    assert.doesNotThrow(() => createApp({ logger: capture().logger, logging: { requests: true } }));
  });
});
