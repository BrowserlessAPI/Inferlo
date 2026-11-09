import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import winston from "winston";
import { createApp, InferloError, job, route, t } from "../src/index.ts";
import { winstonLogger } from "../src/winston.ts";

/** A winston logger with the json format that writes to an array of parsed JSON entries. */
function capture(options: winston.LoggerOptions = {}) {
  const entries: Record<string, any>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) if (line.trim()) entries.push(JSON.parse(line));
      done();
    },
  });
  const log = winston.createLogger({ level: "info", format: winston.format.json(), transports: [new winston.transports.Stream({ stream })], ...options });
  return { log, entries };
}

/** Winston writes through streams; entries arrive after the current tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const items = [
  route.get("/items/:id", { auth: "public", params: t.object({ id: t.string() }) }).handle(({ params }) => ({ id: params.id })),
  route.get("/broken", { auth: "public" }).handle(() => {
    throw new Error("upstream said Authorization: Bearer abcdefghijklmnop and refused");
  }),
];

describe("winstonLogger", () => {
  test("request logs are winston entries with the request id and request fields", async () => {
    const { log, entries } = capture();
    const app = createApp({ routes: items, logger: winstonLogger(log), logging: { requests: true } });
    const res = await app.fetch(new Request("http://localhost/items/7?token=secret"));
    assert.equal(res.status, 200);
    await settle();
    const entry = entries.find((e) => String(e.message).startsWith("GET /items/7 200"));
    assert.ok(entry, `request log written, got ${JSON.stringify(entries)}`);
    assert.equal(entry.level, "info");
    assert.equal(entry.requestId, res.headers.get("x-request-id"));
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/items/7", "no query string");
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, "number");
    assert.equal("data" in entry, false);
    assert.equal("error" in entry, false);
  });

  test("errors are written as plain JSON under error, and redacted", async () => {
    const { log, entries } = capture();
    const app = createApp({ routes: items, logger: winstonLogger(log) });
    const res = await app.fetch(new Request("http://localhost/broken"));
    assert.equal(res.status, 500);
    await settle();
    const entry = entries.find((e) => e.level === "error");
    assert.ok(entry, "error entry written");
    assert.equal(entry.message, "GET /broken failed", "the message is not merged with the error's");
    assert.equal(entry.requestId, res.headers.get("x-request-id"));
    assert.equal(entry.error.name, "Error");
    assert.match(entry.error.message, /Bearer \[redacted\]/);
    assert.match(entry.error.stack, /upstream said/);
    assert.doesNotMatch(JSON.stringify(entry), /abcdefghijklmnop/);
  });

  test("values from createApp({ redact }) never reach winston", async () => {
    const { log, entries } = capture();
    const secret = "s3cr3t-value-123456";
    const app = createApp({
      routes: [route.get("/leak", { auth: "public" }).handle(() => { throw new Error(`could not connect with ${secret}`); })],
      logger: winstonLogger(log),
      redact: [secret],
    });
    await app.fetch(new Request("http://localhost/leak"));
    await settle();
    assert.ok(entries.length > 0);
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret));
  });

  test("job failures are written through winston with their data", async () => {
    const { log, entries } = capture();
    const failing = job("sync", { input: t.object({}), retries: 0 }).handle(() => {
      throw new Error("sync failed");
    });
    const app = createApp({ jobs: [failing], logger: winstonLogger(log) });
    await app.jobs.enqueue(failing, {});
    await app.jobs.runDue();
    await settle();
    const entry = entries.find((e) => e.level === "error" && String(e.message).startsWith('job "sync" failed'));
    assert.ok(entry, `job failure logged, got ${JSON.stringify(entries)}`);
    assert.equal(entry.data.error, "sync failed");
    assert.equal(typeof entry.data.id, "string");
  });

  test("fields are top-level properties, undefined fields are left out and level and message are never overwritten", async () => {
    const { log, entries } = capture();
    const logger = winstonLogger(log);
    logger.info("hello", undefined, { requestId: "r1", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: undefined, level: "error", message: "other" });
    logger.info("with data", { count: 2 });
    logger.error("empty data", "");
    await settle();
    assert.equal(entries[0]!.message, "hello");
    assert.equal(entries[0]!.level, "info");
    assert.equal(entries[0]!.requestId, "r1");
    assert.equal(entries[0]!.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal("spanId" in entries[0]!, false);
    assert.deepEqual(entries[1]!.data, { count: 2 });
    assert.equal(entries[2]!.level, "error");
    assert.equal("data" in entries[2]!, false);
  });

  test("winston's own options still apply: level, defaultMeta and child loggers", async () => {
    const { log, entries } = capture({ level: "error", defaultMeta: { service: "billing" } });
    const logger = winstonLogger(log.child({ component: "inferlo" }));
    logger.info("dropped by the level");
    logger.error("payment failed", { amount: 12 });
    await settle();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.service, "billing");
    assert.equal(entries[0]!.component, "inferlo");
    assert.deepEqual(entries[0]!.data, { amount: 12 });
  });

  test("anything that is not a winston logger raises IL6061", () => {
    for (const value of [undefined, null, "winston", {}, { info() {} }, []]) {
      assert.throws(() => winstonLogger(value as never), (error: unknown) => error instanceof InferloError && error.code === "IL6061" && /winstonLogger\(/.test(error.fix ?? ""));
    }
  });

  test("a winston logger passed to createApp({ logger }) directly raises IL6062 with the fix", () => {
    const { log } = capture();
    assert.throws(() => createApp({ logger: log as never }), (error: unknown) => error instanceof InferloError && error.code === "IL6062" && /winstonLogger\(log\)/.test(error.fix ?? ""));
    assert.throws(() => createApp({ logger: log.child({ service: "x" }) as never }), (error: unknown) => error instanceof InferloError && error.code === "IL6062");
    assert.ok(createApp({ logger: winstonLogger(log) }));
  });
});
