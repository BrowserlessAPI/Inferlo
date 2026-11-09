// SQLite adapter (sqlite() from @browserlessapi/inferlo/sqlite) on the runtime's built-in SQLite: files persist,
// values keep their types, LIKE stays case-sensitive, constraints map to Inferlo's errors, transactions hold the
// connection, and Postgres-only features say so. The shared db, relations, paginate, tenant and audit suites also
// run on it. Node.js, Bun and Deno.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createApp, createDb, InferloError, model, route, t } from "../src/index.ts";
import { likeToGlob, sqlite } from "../src/db/sqlite.ts";

const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const quiet = { info() {}, error() {} };

const Team = model("sq_teams", { name: t.string().max(40).unique() });
const Task = model("sq_tasks", {
  title: t.string().max(100),
  done: t.boolean().default(false),
  points: t.int().default(1),
  score: t.number().optional(),
  dueAt: t.date().optional(),
  labels: t.array(t.string()).default([]),
  meta: t.json().optional(),
  status: t.enum(["open", "closed"]).default("open"),
  teamId: t.ref("sq_teams", { onDelete: "restrict" }),
  embedding: t.vector(3).optional(),
});

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("sqlite()", () => {
  test("a file database keeps its rows when opened again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inferlo-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "app.db");
    const first = createDb([Team, Task], sqlite({ path }));
    await first.$sync();
    const team = await first.sq_teams.insert({ name: "Core" });
    await first.$close();
    const second = createDb([Team, Task], sqlite({ path }));
    assert.deepEqual(await second.$sync({ dryRun: true }), [
      'CREATE UNIQUE INDEX IF NOT EXISTS "sq_teams_name_key" ON "sq_teams" ("name")',
      'CREATE INDEX IF NOT EXISTS "sq_tasks_team_id_idx" ON "sq_tasks" ("team_id")',
    ]);
    assert.equal((await second.sq_teams.get(team.id)).name, "Core");
    assert.deepEqual((await second.$sql("PRAGMA journal_mode")).map((r) => ({ ...r })), [{ journal_mode: "wal" }]);
    await second.$close();
  });

  test("values keep their types: dates, booleans, integers, real numbers, JSON and vectors", async () => {
    const db = createDb([Team, Task], sqlite());
    await db.$sync();
    const team = await db.sq_teams.insert({ name: "A" });
    const due = new Date("2026-12-15T09:30:00.123Z");
    const task = await db.sq_tasks.insert({ title: "Ship", teamId: team.id, dueAt: due, score: 2.5, done: true, labels: ["a", "b"], meta: { n: 1, nested: [true] }, embedding: [1, 0, 0] });
    const again = await db.sq_tasks.get(task.id);
    assert.ok(again.createdAt instanceof Date && again.updatedAt instanceof Date);
    assert.deepEqual(again.dueAt, due);
    assert.equal(again.done, true);
    assert.equal(again.points, 1);
    assert.equal(again.score, 2.5);
    assert.deepEqual(again.labels, ["a", "b"]);
    assert.deepEqual(again.meta, { n: 1, nested: [true] });
    assert.deepEqual(again.embedding, [1, 0, 0]);
    assert.equal(again.status, "open");
    // Dates compare in time order.
    await db.sq_tasks.insert({ title: "Later", teamId: team.id, dueAt: new Date("2027-01-02T00:00:00Z") });
    assert.deepEqual((await db.sq_tasks.findMany({ where: { dueAt: { gt: new Date("2027-01-01T00:00:00Z") } } })).map((r) => r.title), ["Later"]);
    assert.deepEqual((await db.sq_tasks.findMany({ where: { done: false } })).map((r) => r.title), ["Later"]);
    assert.deepEqual((await db.sq_tasks.findMany({ orderBy: { dueAt: "desc" } })).map((r) => r.title), ["Later", "Ship"]);
    // Vector search compares in JavaScript, closest first.
    await db.sq_tasks.insert({ title: "Near", teamId: team.id, embedding: [0.9, 0.1, 0] });
    await db.sq_tasks.insert({ title: "Far", teamId: team.id, embedding: [0, 0, 1] });
    const found = await db.sq_tasks.search({ field: "embedding", vector: [1, 0, 0], limit: 2 });
    assert.deepEqual(found.map((r) => r.row.title), ["Ship", "Near"]);
    assert.equal(found[0]!.distance, 0);
    await db.$close();
  });

  test("like is case-sensitive like Postgres, ilike is not, and % _ and escapes match the same way", async () => {
    const db = createDb([Team, Task], sqlite());
    await db.$sync();
    for (const name of ["Alpha", "alpha", "a_b", "a*b", "100%"]) await db.sq_teams.insert({ name });
    const names = async (where: object) => (await db.sq_teams.findMany({ where, orderBy: { name: "asc" } })).map((r) => r.name);
    assert.deepEqual(await names({ name: { like: "Al%" } }), ["Alpha"]);
    assert.deepEqual(await names({ name: { ilike: "al%" } }), ["Alpha", "alpha"]);
    assert.deepEqual(await names({ name: { like: "a\\_b" } }), ["a_b"]);
    assert.deepEqual(await names({ name: { like: "a_b" } }), ["a*b", "a_b"]);
    assert.deepEqual(await names({ name: { like: "a*b" } }), ["a*b"]);
    assert.deepEqual(await names({ name: { ilike: "100\\%" } }), ["100%"]);
    assert.equal(likeToGlob("a%b_c*[\\%"), "a*b?c[*][[]%");
    await db.$close();
  });

  test("unique and foreign key violations are IL4004 and IL4011; a missing table is IL4012", async () => {
    const db = createDb([Team, Task], sqlite());
    await assert.rejects(db.sq_teams.insert({ name: "X" }), isCode("IL4012"));
    await db.$sync();
    const team = await db.sq_teams.insert({ name: "X" });
    await assert.rejects(db.sq_teams.insert({ name: "X" }), (e: unknown) => isCode("IL4004")(e) && (e as InferloError).status === 409);
    await assert.rejects(db.sq_tasks.insert({ title: "t", teamId: crypto.randomUUID() }), isCode("IL4011"));
    await db.sq_tasks.insert({ title: "t", teamId: team.id });
    await assert.rejects(db.sq_teams.delete(team.id), isCode("IL4011"));
    await assert.rejects(db.$sql(`INSERT INTO "sq_tasks" ("id", "created_at", "updated_at", "title", "team_id", "status") VALUES (?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), new Date(), new Date(), "x", team.id, "nope"]), /CHECK constraint failed/);
    await db.$close();
  });

  test("a transaction holds the connection: other queries wait for it and do not join it", async () => {
    const db = createDb([Team, Task], sqlite());
    await db.$sync();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tx = db.$transaction(async (tx) => {
      await tx.sq_teams.insert({ name: "in-tx" });
      await gate;
      throw new Error("rollback");
    });
    await new Promise((r) => setTimeout(r, 10));
    const outside = db.sq_teams.insert({ name: "outside" });
    const counted = db.sq_teams.count();
    release();
    await assert.rejects(tx, /rollback/);
    await outside;
    assert.equal(await counted, 1);
    assert.deepEqual((await db.sq_teams.findMany()).map((r) => r.name), ["outside"]);
    const kept = await db.$transaction(async (tx) => {
      const a = await tx.sq_teams.insert({ name: "kept" });
      return tx.$transaction(async (inner) => inner.sq_teams.get(a.id));
    });
    assert.equal(kept.name, "kept");
    await db.$close();
  });

  test("invalid options are IL4033", () => {
    assert.throws(() => sqlite({ file: "x.db" } as never), isCode("IL4033"));
    assert.throws(() => sqlite({ path: "" }), isCode("IL4033"));
    assert.throws(() => sqlite({ busyTimeoutMs: -1 }), isCode("IL4033"));
  });

  test("Postgres-only features say so: database job queue, cache and rate limits, $pgClient", async () => {
    assert.throws(() => createApp({ db: sqlite(), jobQueue: { store: "database" }, logger: quiet }), isCode("IL6012"));
    assert.throws(() => createApp({ db: sqlite(), cache: { store: "database" }, logger: quiet }), (e: unknown) => e instanceof InferloError && /Postgres/.test(e.message));
    const db = createDb([Team], sqlite());
    await assert.rejects(db.$pgClient(), isCode("IL4028"));
    await db.$close();
  });

  test("in an app: routes use it, readiness checks it, describe names it", async () => {
    const list = route.get("/teams", { auth: "public" }).handle(async ({ db }) => (db as any).sq_teams.findMany());
    const app = createApp({ models: [Team], routes: [{ list }], db: sqlite(), health: true, logger: quiet });
    await app.db.$sync();
    await (app.db as any).sq_teams.insert({ name: "Web" });
    assert.deepEqual((await (await app.request("/teams")).json()).map((r: { name: string }) => r.name), ["Web"]);
    assert.equal((await app.request("/ready")).status, 200);
    assert.equal(app.describe().database, "sqlite");
    await app.close();
  });
});
