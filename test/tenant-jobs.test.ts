import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient } from "redis";
import { createApp, event, InferloError, job, memory, model, on, route, t, type Adapter, type AppUser, type EventMessage, type EventTransport } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import type { RedisClient } from "../src/redis.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info: () => {}, error: () => {} };
// Unique job and event names per run, so runs against one database or Redis do not see each other's jobs.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const Board = model("tj_boards", { name: t.string() }, { tenant: true });
const Plain = model("tj_plain", { name: t.string() });
const models = [Board, Plain] as const;
type Db = { tj_boards: { get(id: string): Promise<{ name: string; tenantId: string }>; count(): Promise<number>; insert(v: { name: string }): Promise<{ id: string }> } };

const ACME: AppUser & { tenantId: string } = { id: "11111111-1111-4111-8111-111111111111", tenantId: "acme" };
const LONER: AppUser = { id: "22222222-2222-4222-8222-222222222222" };

interface Seen {
  job: string;
  tenantId: string | null;
  count?: number;
  error?: string;
}

function setup(store: "memory" | "database" | "redis", db: Adapter, extra: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  const boardCreated = event(`board.created.${store}.${suffix}`, { payload: t.object({ boardId: t.uuid() }) });
  const record = async (name: string, ctx: { db: unknown; tenantId: string | null }) => {
    try {
      seen.push({ job: name, tenantId: ctx.tenantId, count: await (ctx.db as Db).tj_boards.count() });
    } catch (error) {
      seen.push({ job: name, tenantId: ctx.tenantId, error: (error as InferloError).code });
    }
  };
  const followUp = job(`tj-follow-${store}-${suffix}`, { input: t.object({}), retries: 0 }).handle((ctx) => record("follow", ctx));
  const audit = job(`tj-audit-${store}-${suffix}`, { input: t.object({ boardId: t.uuid() }), retries: 0 }).handle(async (ctx) => {
    await record("audit", ctx);
    const board = await (ctx.db as unknown as Db).tj_boards.get(ctx.input.boardId);
    assert.equal(board.tenantId, ctx.tenantId);
    await ctx.jobs.enqueue(followUp, {});
    await ctx.jobs.enqueue(followUp, {}, { tenantId: null });
  });
  const notify = job(`tj-notify-${store}-${suffix}`, { input: t.object({ boardId: t.uuid() }), retries: 0 }).handle((ctx) => record("notify", ctx));
  const routes = {
    create: route.post("/boards", { body: t.object({ name: t.string() }) }).handle(async (ctx) => {
      const board = await (ctx.db as unknown as Db).tj_boards.insert(ctx.body);
      await ctx.jobs.enqueue(audit, { boardId: board.id });
      await ctx.events.publish(boardCreated, { boardId: board.id });
      return board;
    }),
    ping: route.post("/ping").handle(async (ctx) => {
      await ctx.jobs.enqueue(followUp, {});
      return { ok: true };
    }),
  };
  const app = createApp({
    models,
    db,
    routes: [routes],
    jobs: [audit, notify, followUp, on(boardCreated, notify)],
    jobQueue: { store },
    auth: { resolve: () => null },
    logger: quiet,
    ...extra,
  });
  return { app, seen, audit, followUp, boardCreated };
}

async function exercise(store: "memory" | "database" | "redis", db: Adapter, extra: Record<string, unknown> = {}) {
  const { app, seen, followUp } = setup(store, db, extra);
  await app.db.$sync();
  // The first receive creates the consumer group, which reads events published after it.
  if (app.events.transport) await app.events.receive();
  const created = await app.request("/boards", { method: "POST", json: { name: "Roadmap" }, as: ACME });
  assert.equal(created.status, 200);
  if (app.events.transport) assert.equal(await app.events.receive(), 1);
  await app.jobs.runDue();
  const byJob = (name: string) => seen.filter((s) => s.job === name).sort((a, b) => String(a.tenantId).localeCompare(String(b.tenantId)));
  assert.deepEqual(byJob("audit"), [{ job: "audit", tenantId: "acme", count: 1 }], "a job queued by a request gets its tenant");
  assert.deepEqual(byJob("notify"), [{ job: "notify", tenantId: "acme", count: 1 }], "jobs of an event published by a request get its tenant");
  assert.deepEqual(byJob("follow"), [
    { job: "follow", tenantId: "acme", count: 1 },
    { job: "follow", tenantId: null, error: "IL4027" },
  ], "a follow-up keeps the tenant unless it is queued with tenantId: null");

  seen.length = 0;
  const queued = await app.jobs.enqueue(followUp, {}, { tenantId: "globex" });
  assert.equal((await app.jobs.get(queued.id))?.tenantId, "globex", "the store keeps the tenant");
  await app.jobs.enqueue(followUp, {});
  await app.request("/ping", { method: "POST", as: LONER });
  await app.jobs.runDue();
  assert.deepEqual(byJob("follow"), [
    { job: "follow", tenantId: "globex", count: 0 },
    { job: "follow", tenantId: null, error: "IL4027" },
    { job: "follow", tenantId: null, error: "IL4027" },
  ]);
  await assert.rejects(app.jobs.enqueue(followUp, {}, { tenantId: "" }), (e: InferloError) => e.code === "IL4027");
  await app.db.$allTenants().tj_boards.findMany().then((rows) => Promise.all(rows.map((r) => app.db.$tenant(r.tenantId).tj_boards.delete(r.id))));
}

describe("tenant in jobs and events", () => {
  test("memory store: jobs and event jobs run for the tenant that queued them", async () => {
    await exercise("memory", memory());
  });

  test("app.events.publish takes a tenantId, and an invalid one raises IL4027", async () => {
    const { app, seen, boardCreated } = setup("memory", memory());
    const board = await app.db.$tenant("initech").tj_boards.insert({ name: "B" });
    await app.events.publish(boardCreated, { boardId: board.id }, { tenantId: "initech" });
    await app.events.publish(boardCreated, { boardId: board.id });
    await app.jobs.runDue();
    assert.deepEqual(seen.map((s) => s.tenantId).sort(), ["initech", null]);
    await assert.rejects(app.events.publish(boardCreated, { boardId: board.id }, { tenantId: 5 as never }), (e: InferloError) => e.code === "IL4027");
  });

  test("an event transport carries the tenant to the subscribed jobs", async () => {
    const sent: EventMessage[] = [];
    const transport: EventTransport = {
      name: "test",
      send: async (message) => void sent.push(JSON.parse(JSON.stringify(message))),
      async receive(names, deliver) {
        let n = 0;
        for (const message of sent.splice(0)) if (names.includes(message.name)) (await deliver({ ...message, publishedAt: new Date(message.publishedAt) }), n++);
        return n;
      },
    };
    const { app, seen } = setup("memory", memory(), { events: { transport } });
    await app.db.$sync();
    await app.request("/boards", { method: "POST", json: { name: "Remote" }, as: ACME });
    assert.equal(sent[0]?.tenantId, "acme");
    await app.events.receive();
    await app.jobs.runDue();
    assert.deepEqual(seen.find((s) => s.job === "notify"), { job: "notify", tenantId: "acme", count: 1 });
  });

  test("describe() marks tenant-scoped models", () => {
    const app = createApp({ models, routes: [] });
    assert.equal(app.describe().models.find((m) => m.name === "tj_boards")?.tenant, true);
    assert.equal("tenant" in app.describe().models.find((m) => m.name === "tj_plain")!, false);
  });
});

if (PG_URL) {
  describe("tenant in jobs (database store)", () => {
    const db = postgres({ url: PG_URL });
    before(async () => {
      await db.sql!('DROP TABLE IF EXISTS "tj_boards", "tj_plain" CASCADE');
    });
    after(async () => {
      await db.close?.();
    });
    test("the tenant is stored in inferlo_jobs and the job runs for it", async () => {
      await exercise("database", db);
    });
  });
}

if (REDIS_URL) {
  describe("tenant in jobs and events (Redis)", () => {
    const connected = createClient({ url: REDIS_URL }).connect();
    const redis: RedisClient = { sendCommand: async (args) => (await connected).sendCommand(args) };
    after(async () => {
      await (await connected).close();
    });
    test("the tenant is stored in the Redis job and travels with Redis Streams events", async () => {
      await exercise("redis", memory(), { name: `tj-${suffix}`, redis, events: { transport: "redis" } });
    });
  });
}
