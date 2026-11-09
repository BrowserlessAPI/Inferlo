// MySQL adapter (mysql() from @browserlessapi/inferlo/mysql) with mysql2: values keep their types, comparisons are
// case-sensitive as on Postgres, constraints map to Inferlo's errors, updates read rows back without RETURNING, and
// Postgres-only features say so. Needs INFERLO_TEST_MYSQL_URL (mysql://root:root@localhost:3306/inferlo); the shared
// db, relations, paginate, tenant and audit suites also run on it.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { applyMigrations, createApp, createDb, InferloError, model, t } from "../src/index.ts";
import { mysql } from "../src/db/mysql.ts";
import { databaseRateLimitStore } from "../src/rate-limit.ts";
import { MYSQL_URL, mysqlAdapter } from "./mysql-adapter.ts";

const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const quiet = { info() {}, error() {} };

describe("mysql() options", () => {
  test("invalid options are IL4036, and a missing URL is IL4009 on first use", async () => {
    assert.throws(() => mysql({ url: "postgres://x" }), isCode("IL4036"));
    assert.throws(() => mysql({ url: "mysql://x", pool: {} as never }), isCode("IL4036"));
    assert.throws(() => mysql({ host: "x" } as never), isCode("IL4036"));
    assert.throws(() => mysql({ pool: {} as never }), isCode("IL4036"));
    assert.throws(() => mysql({ url: "mysql://x", max: 0 }), isCode("IL4036"));
    const db = createDb([], mysql());
    await assert.rejects(db.$sql("SELECT 1"), isCode("IL4009"));
  });
});

const Team = model("my_teams", { name: t.string().max(40).unique(), settings: t.json().default({ plan: "free" }) });
const Task = model("my_tasks", {
  title: t.string().max(100),
  body: t.text().default(""),
  done: t.boolean().default(false),
  points: t.int().default(1),
  score: t.number().optional(),
  dueAt: t.date().optional(),
  labels: t.array(t.string()).default([]),
  status: t.enum(["open", "closed"]).default("open"),
  slug: t.string().optional().index(),
  teamId: t.ref("my_teams", { onDelete: "restrict" }),
  embedding: t.vector(3).optional(),
});

// Defined only with a server: Bun 1.3.0 runs the body of a skipped describe, which would create the db.
if (!MYSQL_URL) test.skip("mysql() against a server: set INFERLO_TEST_MYSQL_URL", () => {});
else describe("mysql()", () => {
  const adapter = mysqlAdapter();
  const db = createDb([Team, Task], adapter);
  after(async () => {
    await db.$close();
  });

  test("sync creates the tables once, with indexes and foreign keys", async () => {
    const first = await db.$sync();
    assert.ok(first.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS `my_tasks`") && s.includes("FOREIGN KEY (`team_id`) REFERENCES `my_teams` (`id`) ON DELETE RESTRICT")));
    assert.ok(first.includes("CREATE UNIQUE INDEX `my_teams_name_key` ON `my_teams` (`name`)"));
    assert.deepEqual(await db.$sync({ dryRun: true }), []);
    const Extended = model("my_teams", { name: t.string().max(40).unique(), settings: t.json().default({ plan: "free" }), motto: t.string().optional() });
    assert.deepEqual(await createDb([Extended], adapter).$sync(), ["ALTER TABLE `my_teams` ADD COLUMN `motto` TEXT"]);
  });

  test("values keep their types: dates, booleans, integers, real numbers, JSON with defaults and vectors", async () => {
    const team = await db.my_teams.insert({ name: "Core" });
    assert.deepEqual(team.settings, { plan: "free" });
    const due = new Date("2026-12-15T09:30:00.123Z");
    const task = await db.my_tasks.insert({ title: "Ship", teamId: team.id, dueAt: due, score: 2.5, done: true, labels: ["a", "b"], embedding: [1, 0, 0] });
    const again = await db.my_tasks.get(task.id);
    assert.deepEqual(again.dueAt, due);
    assert.ok(again.createdAt instanceof Date && Math.abs(again.createdAt.getTime() - Date.now()) < 60_000, "dates are UTC");
    assert.equal(again.done, true);
    assert.equal(again.points, 1);
    assert.equal(again.score, 2.5);
    assert.equal(again.body, "");
    assert.deepEqual(again.labels, ["a", "b"]);
    assert.deepEqual(again.embedding, [1, 0, 0]);
    assert.deepEqual((await db.my_tasks.findMany({ where: { done: true } })).map((r) => r.title), ["Ship"]);
    assert.deepEqual((await db.my_tasks.findMany({ where: { labels: ["a", "b"] } })).map((r) => r.title), ["Ship"]);
    assert.deepEqual((await db.my_tasks.findMany({ where: { dueAt: { gt: new Date("2026-12-15T09:30:00Z") } } })).map((r) => r.title), ["Ship"]);
    await db.my_tasks.insert({ title: "Near", teamId: team.id, embedding: [0.9, 0.1, 0] });
    const found = await db.my_tasks.search({ field: "embedding", vector: [1, 0, 0], limit: 2 });
    assert.deepEqual(found.map((r) => r.row.title), ["Ship", "Near"]);
  });

  test("comparisons are case-sensitive like Postgres; ilike is not", async () => {
    for (const name of ["Alpha", "alpha", "a_b", "axb"]) await db.my_teams.insert({ name });
    const names = async (where: object) => (await db.my_teams.findMany({ where, orderBy: { name: "asc" } })).map((r) => r.name);
    assert.deepEqual(await names({ name: "Alpha" }), ["Alpha"]);
    assert.deepEqual(await names({ name: { like: "al%" } }), ["alpha"]);
    assert.deepEqual(await names({ name: { ilike: "al%" } }), ["Alpha", "alpha"]);
    assert.deepEqual(await names({ name: { like: "a\\_b" } }), ["a_b"]);
  });

  test("update and delete return what changed, without RETURNING", async () => {
    const team = await db.my_teams.insert({ name: "Upd" });
    const a = await db.my_tasks.insert({ title: "u1", teamId: team.id });
    await db.my_tasks.insert({ title: "u2", teamId: team.id });
    const updated = await db.my_tasks.update(a.id, { points: 5, labels: ["x"] });
    assert.equal(updated.points, 5);
    assert.deepEqual(updated.labels, ["x"]);
    assert.ok(updated.updatedAt.getTime() >= a.updatedAt.getTime());
    assert.equal(await db.my_tasks.count({ teamId: team.id }), 2);
    assert.equal(await db.my_tasks.deleteMany({ teamId: team.id }), 2);
  });

  test("unique and foreign key violations are IL4004 and IL4011; transactions roll back", async () => {
    const team = await db.my_teams.insert({ name: "Unique" });
    await assert.rejects(db.my_teams.insert({ name: "Unique" }), (e: unknown) => isCode("IL4004")(e) && (e as InferloError).status === 409);
    await assert.rejects(db.my_tasks.insert({ title: "t", teamId: crypto.randomUUID() }), isCode("IL4011"));
    await db.my_tasks.insert({ title: "t", teamId: team.id });
    await assert.rejects(db.my_teams.delete(team.id), isCode("IL4011"));
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.my_teams.insert({ name: "in-tx" });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await db.my_teams.count({ name: "in-tx" }), 0);
    assert.deepEqual(await db.$sql("SELECT COUNT(*) AS n FROM `my_teams` WHERE `name` = ?", ["Unique"]), [{ n: 1 }]);
  });

  test("a missing table is IL4012; Postgres-only features say so", async () => {
    const other = createDb([model("my_missing", { x: t.string() })], adapter);
    await assert.rejects(other.my_missing.insert({ x: "a" }), isCode("IL4012"));
    await assert.rejects(applyMigrations(db, [{ name: "0001_init", sql: "SELECT 1" }]), isCode("IL4035"));
    await assert.rejects(db.$pgClient(), isCode("IL4028"));
    assert.equal(createApp({ db: adapter, logger: quiet }).describe().database, "mysql");
  });

  test('the "database" stores for jobs, cache and rate limits use MySQL tables', async () => {
    const app = createApp({ db: adapter, jobQueue: { store: "database" }, cache: { store: "database" }, rateLimit: { store: "database" }, logger: quiet });
    assert.equal(app.describe().jobQueue, "database");
    assert.equal(app.describe().cache, "database");
    const store = databaseRateLimitStore(adapter);
    const key = `concurrent-${crypto.randomUUID()}`;
    const hits = await Promise.all(Array.from({ length: 20 }, () => store.hit(key, 60_000)));
    assert.deepEqual(hits.map((h) => h.count).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1), "concurrent hits are counted one by one");
    assert.ok(hits.every((h) => h.resetMs > 55_000 && h.resetMs <= 60_000));
    const tables = (await db.$sql("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME LIKE 'inferlo\\_%' ORDER BY TABLE_NAME")).map((r) => r.name);
    assert.ok(tables.includes("inferlo_rate_limits"));
  });
});
