import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Fastify from "fastify";
import pino from "pino";
import { createApp, InferloError, job, route, t } from "../src/index.ts";
import { pinoLogger } from "../src/pino.ts";

/** A pino logger that writes to an array of parsed JSON entries. */
function capture(options: pino.LoggerOptions = {}) {
  const entries: Record<string, any>[] = [];
  const log = pino(options, { write: (line: string) => void entries.push(JSON.parse(line)) });
  return { log, entries };
}

const items = [
  route.get("/items/:id", { auth: "public", params: t.object({ id: t.string() }) }).handle(({ params }) => ({ id: params.id })),
  route.get("/broken", { auth: "public" }).handle(() => {
    throw new Error("upstream said Authorization: Bearer abcdefghijklmnop and refused");
  }),
];

describe("pinoLogger", () => {
  test("request logs are pino entries with the request id and request fields", async () => {
    const { log, entries } = capture();
    const app = createApp({ routes: items, logger: pinoLogger(log), logging: { requests: true } });
    const res = await app.fetch(new Request("http://localhost/items/7?token=secret"));
    assert.equal(res.status, 200);
    const entry = entries.find((e) => e.msg?.startsWith("GET /items/7 200"));
    assert.ok(entry, `request log written, got ${JSON.stringify(entries)}`);
    assert.equal(entry.level, 30, "info level");
    assert.equal(entry.requestId, res.headers.get("x-request-id"));
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/items/7", "no query string");
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, "number");
    assert.equal("data" in entry, false);
    assert.equal("err" in entry, false);
  });

  test("errors are passed as err, serialized by pino, and redacted", async () => {
    const { log, entries } = capture();
    const app = createApp({ routes: items, logger: pinoLogger(log) });
    const res = await app.fetch(new Request("http://localhost/broken"));
    assert.equal(res.status, 500);
    const entry = entries.find((e) => e.level === 50);
    assert.ok(entry, "error entry written");
    assert.equal(entry.msg, "GET /broken failed");
    assert.equal(entry.requestId, res.headers.get("x-request-id"));
    assert.equal(entry.err.type, "Error");
    assert.match(entry.err.message, /Bearer \[redacted\]/);
    assert.doesNotMatch(JSON.stringify(entry), /abcdefghijklmnop/);
    assert.match(entry.err.stack, /upstream said/);
  });

  test("values from createApp({ redact }) never reach pino", async () => {
    const { log, entries } = capture();
    const secret = "s3cr3t-value-123456";
    const app = createApp({
      routes: [route.get("/leak", { auth: "public" }).handle(() => { throw new Error(`could not connect with ${secret}`); })],
      logger: pinoLogger(log),
      redact: [secret],
    });
    await app.fetch(new Request("http://localhost/leak"));
    assert.ok(entries.length > 0);
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret));
  });

  test("job failures are written through pino with their data", async () => {
    const { log, entries } = capture();
    const failing = job("sync", { input: t.object({}), retries: 0 }).handle(() => {
      throw new Error("sync failed");
    });
    const app = createApp({ jobs: [failing], logger: pinoLogger(log) });
    await app.jobs.enqueue(failing, {});
    await app.jobs.runDue();
    const entry = entries.find((e) => e.level === 50 && String(e.msg).startsWith('job "sync" failed'));
    assert.ok(entry, `job failure logged, got ${JSON.stringify(entries)}`);
    assert.equal(entry.data.error, "sync failed");
    assert.equal(typeof entry.data.id, "string");
  });

  test("fields are top-level properties and undefined fields are left out", () => {
    const { log, entries } = capture();
    const logger = pinoLogger(log);
    logger.info("hello", undefined, { requestId: "r1", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: undefined });
    logger.info("with data", { count: 2 });
    logger.error("empty data", "");
    assert.equal(entries[0]!.msg, "hello");
    assert.equal(entries[0]!.requestId, "r1");
    assert.equal(entries[0]!.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal("spanId" in entries[0]!, false);
    assert.deepEqual(entries[1]!.data, { count: 2 });
    assert.equal(entries[2]!.level, 50);
    assert.equal("data" in entries[2]!, false);
  });

  test("pino's own options still apply: level, base fields and redact", async () => {
    const { log, entries } = capture({ level: "error", base: { service: "billing" }, redact: ["data.card"] });
    const logger = pinoLogger(log);
    logger.info("dropped by the level");
    logger.error("payment failed", { card: "4111" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.service, "billing");
    assert.equal(entries[0]!.data.card, "[Redacted]");
  });

  test("an Inferlo app mounted in Fastify writes to fastify.log", async () => {
    const entries: Record<string, any>[] = [];
    const fastify = Fastify({ logger: { stream: { write: (line: string) => void entries.push(JSON.parse(line)) } } });
    const app = createApp({ routes: items, logger: pinoLogger(fastify.log), logging: { requests: true } });
    await fastify.ready();
    await app.fetch(new Request("http://localhost/items/1"));
    assert.ok(entries.some((e) => String(e.msg).startsWith("GET /items/1 200") && typeof e.requestId === "string"));
    await fastify.close();
  });

  test("anything that is not a pino logger raises IL6052", () => {
    for (const value of [undefined, null, "pino", {}, { info() {} }, []]) {
      assert.throws(() => pinoLogger(value as never), (error: unknown) => error instanceof InferloError && error.code === "IL6052" && /pinoLogger\(pino\(\)\)/.test(error.fix ?? ""));
    }
  });

  test("a pino logger passed to createApp({ logger }) directly raises IL6053 with the fix", () => {
    const { log } = capture();
    assert.throws(() => createApp({ logger: log }), (error: unknown) => error instanceof InferloError && error.code === "IL6053" && /pinoLogger\(log\)/.test(error.fix ?? ""));
    assert.throws(() => createApp({ logger: Fastify({ logger: { level: "silent" } }).log as never }), (error: unknown) => error instanceof InferloError && error.code === "IL6053");
  });

  test("other loggers are not mistaken for pino", () => {
    const lines: string[] = [];
    const app = createApp({ logger: { info: (m) => void lines.push(m), error: (m) => void lines.push(m) } });
    assert.ok(app);
  });
});
