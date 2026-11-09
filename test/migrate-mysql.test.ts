// Migration files on MySQL: planMigration(models, snapshot, { dialect: "mysql" }) generates new tables, columns and
// indexes, applyMigrations() runs them statement by statement under a named lock, and inferlo db migrate does both
// for an app on mysql(). The server tests need INFERLO_TEST_MYSQL_URL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { applyMigrations, createDb, InferloError, model, planMigration, t } from "../src/index.ts";
import { splitStatements } from "../src/db/migrate-mysql.ts";
import { MYSQL_URL, mysqlAdapter } from "./mysql-adapter.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

const Team = model("mm_teams", { name: t.string().max(40).unique() });
const Note = model("mm_notes", { title: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }) });
const NoteV2 = model("mm_notes", {
  title: t.string().max(100),
  body: t.text().default(""),
  teamId: t.ref("mm_teams", { onDelete: "cascade" }),
  status: t.enum(["open", "done"]).default("open"),
  slug: t.string().max(80).optional().index(),
  ownerId: t.ref("mm_teams").optional(),
  tags: t.array(t.string()).default([]),
});

describe("planMigration on MySQL", () => {
  test("the first migration creates the tables, referenced tables first, with indexes and foreign keys", () => {
    const plan = planMigration([Note, Team], undefined, { dialect: "mysql" });
    assert.match(plan.statements[0]!, /^CREATE TABLE IF NOT EXISTS `mm_teams`/);
    assert.ok(plan.statements[0]!.includes("COLLATE = utf8mb4_bin"));
    assert.ok(plan.statements.includes("CREATE UNIQUE INDEX `mm_teams_name_key` ON `mm_teams` (`name`)"));
    const notes = plan.statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS `mm_notes`"))!;
    assert.ok(notes.includes("CONSTRAINT `mm_notes_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `mm_teams` (`id`) ON DELETE CASCADE"));
    assert.equal(plan.snapshot.dialect, "mysql");
    assert.deepEqual(plan.snapshot.tables.mm_notes!.columns.body, { type: "MEDIUMTEXT", notNull: true, default: "('')" });
    assert.deepEqual(planMigration([Note, Team], plan.snapshot, { dialect: "mysql" }).statements, [], "nothing changed");
  });

  test("new columns, foreign keys and indexes on an existing table", () => {
    const first = planMigration([Team, Note], undefined, { dialect: "mysql" });
    const plan = planMigration([Team, NoteV2], first.snapshot, { dialect: "mysql" });
    assert.deepEqual(plan.statements, [
      "ALTER TABLE `mm_notes` ADD COLUMN `status` VARCHAR(255) DEFAULT 'open' NOT NULL CHECK (`status` IN ('open', 'done'))",
      "ALTER TABLE `mm_notes` ADD COLUMN `slug` VARCHAR(80)",
      "ALTER TABLE `mm_notes` ADD COLUMN `owner_id` CHAR(36)",
      "ALTER TABLE `mm_notes` ADD CONSTRAINT `mm_notes_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `mm_teams` (`id`) ON DELETE RESTRICT",
      "ALTER TABLE `mm_notes` ADD COLUMN `tags` JSON DEFAULT (CAST('[]' AS JSON)) NOT NULL",
      "CREATE INDEX `mm_notes_slug_idx` ON `mm_notes` (`slug`)",
    ]);
  });

  test("a new required column without a default is IL4014; changes and renames are IL4013 for now", () => {
    const first = planMigration([Team, Note], undefined, { dialect: "mysql" });
    const required = model("mm_notes", { title: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }), rank: t.int() });
    assert.throws(() => planMigration([Team, required], first.snapshot, { dialect: "mysql" }), isCode("IL4014"));
    const changed = model("mm_notes", { title: t.string().max(200), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }) });
    assert.throws(() => planMigration([Team, changed], first.snapshot, { dialect: "mysql", allowChange: true }), (e: unknown) => isCode("IL4013")(e) && /change column mm_notes\.title/.test((e as Error).message));
    assert.throws(() => planMigration([Team, Note], first.snapshot, { dialect: "mysql", renames: { "mm_notes.body": "mm_notes.text" } }), isCode("IL4013"));
  });

  test("drops of tables, columns (foreign key first) and indexes need allowDrop (IL4017)", () => {
    const full = planMigration([Team, NoteV2], undefined, { dialect: "mysql" });
    const Smaller = model("mm_notes", { title: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }), status: t.enum(["open", "done"]).default("open"), tags: t.array(t.string()).default([]) });
    assert.throws(
      () => planMigration([Team, Smaller], full.snapshot, { dialect: "mysql" }),
      (e: unknown) => isCode("IL4017")(e) && Array.isArray(((e as InferloError).details as { drops?: unknown }).drops) && /drop column mm_notes\.slug/.test((e as Error).message) && /--allow-drop/.test((e as InferloError).fix!),
    );
    const plan = planMigration([Team, Smaller], full.snapshot, { dialect: "mysql", allowDrop: true });
    assert.deepEqual(plan.statements, [
      "DROP INDEX `mm_notes_slug_idx` ON `mm_notes`",
      "ALTER TABLE `mm_notes` DROP COLUMN `slug`",
      "ALTER TABLE `mm_notes` DROP FOREIGN KEY `mm_notes_owner_id_fkey`",
      "ALTER TABLE `mm_notes` DROP COLUMN `owner_id`",
    ]);
    assert.deepEqual(plan.drops, ["drop index mm_notes_slug_idx", "drop column mm_notes.slug", "drop column mm_notes.owner_id"]);
    const tablesGone = planMigration([], full.snapshot, { dialect: "mysql", allowDrop: true });
    assert.deepEqual(tablesGone.statements, ["DROP TABLE IF EXISTS `mm_teams`, `mm_notes`"]);
    const Renamed = model("mm_notes", { headline: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }) });
    const first = planMigration([Team, Note], undefined, { dialect: "mysql" });
    assert.throws(() => planMigration([Team, Renamed], first.snapshot, { dialect: "mysql" }), (e: unknown) => isCode("IL4017")(e) && /renames are not generated on MySQL yet/.test((e as InferloError).fix!));
  });

  test("a snapshot written for the other database is IL4037", () => {
    const postgresSnapshot = planMigration([Team]).snapshot;
    assert.equal(postgresSnapshot.dialect, undefined);
    assert.throws(() => planMigration([Team], postgresSnapshot, { dialect: "mysql" }), isCode("IL4037"));
    const mysqlSnapshot = planMigration([Team], undefined, { dialect: "mysql" }).snapshot;
    assert.throws(() => planMigration([Team], mysqlSnapshot), isCode("IL4037"));
    assert.throws(() => planMigration([Team], { inferlo: 3 } as never, { dialect: "mysql" }), isCode("IL4015"));
  });

  test("migration files are split at semicolons outside strings, names and comments", () => {
    const sql = [
      "-- Generated; review it",
      "CREATE TABLE `a;b` (`x` TEXT DEFAULT ('it''s; fine'));",
      "/* a comment; */ INSERT INTO `a;b` VALUES ('one\\'; two', \"three;\");",
      "# only a comment;",
      "UPDATE `a;b` SET `x` = 'y'",
    ].join("\n");
    assert.deepEqual(splitStatements(sql), [
      "-- Generated; review it\nCREATE TABLE `a;b` (`x` TEXT DEFAULT ('it''s; fine'))",
      "/* a comment; */ INSERT INTO `a;b` VALUES ('one\\'; two', \"three;\")",
      "# only a comment;\nUPDATE `a;b` SET `x` = 'y'",
    ]);
    assert.deepEqual(splitStatements("  ;\n-- nothing\n"), []);
  });
});

if (!MYSQL_URL) test.skip("migrations against a MySQL server: set INFERLO_TEST_MYSQL_URL", () => {});
else describe("applyMigrations on MySQL", () => {
  const adapter = mysqlAdapter();
  const db = createDb([], adapter);
  after(async () => {
    await db.$close();
  });
  const first = planMigration([Team, Note], undefined, { dialect: "mysql" });
  const second = planMigration([Team, NoteV2], first.snapshot, { dialect: "mysql" });
  const file = (statements: string[]) => `-- Generated by inferlo db migrate.\n\n${statements.join(";\n\n")};\n`;

  test("generated files apply in order, are recorded once, and concurrent runs apply each file once", async () => {
    const migrations = [
      { name: "0001_init", sql: file(first.statements) },
      { name: "0002_more", sql: file(second.statements) },
    ];
    const results = await Promise.all([applyMigrations(db, migrations), applyMigrations(db, migrations), applyMigrations(db, migrations)]);
    assert.deepEqual(results.flat().sort(), ["0001_init", "0002_more"], "each file ran once across the three runs");
    assert.deepEqual(await applyMigrations(db, migrations), []);
    const typed = createDb([Team, NoteV2], adapter);
    const team = await typed.mm_teams.insert({ name: "Core" });
    const note = await typed.mm_notes.insert({ title: "A", teamId: team.id });
    assert.equal(note.status, "open");
    assert.deepEqual(note.tags, []);
    await assert.rejects(typed.mm_notes.insert({ title: "B", teamId: crypto.randomUUID() }), isCode("IL4011"));
    assert.deepEqual(await typed.$sync({ dryRun: true }), [], "the migrated tables match what db push would create");
    const recorded = await db.$sql("SELECT `name`, LENGTH(`checksum`) AS n FROM `inferlo_migrations` ORDER BY `name`");
    assert.deepEqual(recorded, [{ name: "0001_init", n: 64 }, { name: "0002_more", n: 64 }]);
  });

  test("edited files are reported (IL4018) and not run again", async () => {
    let edited: string[] = [];
    const applied = await applyMigrations(db, [{ name: "0001_init", sql: "SELECT 1" }, { name: "0002_more", sql: file(second.statements) }], { onEdited: (names) => (edited = names) });
    assert.deepEqual(applied, []);
    assert.deepEqual(edited, ["0001_init"]);
  });

  test("generated drops apply: foreign key, column, index and table", async () => {
    const Smaller = model("mm_notes", { title: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }), status: t.enum(["open", "done"]).default("open"), tags: t.array(t.string()).default([]) });
    const dropColumns = planMigration([Team, Smaller], second.snapshot, { dialect: "mysql", allowDrop: true });
    const Extra = model("mm_extra", { teamId: t.ref("mm_teams") });
    const withExtra = planMigration([Team, Smaller, Extra], dropColumns.snapshot, { dialect: "mysql" });
    const dropTable = planMigration([Team, Smaller], withExtra.snapshot, { dialect: "mysql", allowDrop: true });
    const applied = await applyMigrations(db, [
      { name: "0001_init", sql: file(first.statements) },
      { name: "0002_more", sql: file(second.statements) },
      { name: "0010_drop_columns", sql: file(dropColumns.statements) },
      { name: "0011_extra", sql: file(withExtra.statements) },
      { name: "0012_drop_extra", sql: file(dropTable.statements) },
    ]);
    assert.deepEqual(applied, ["0010_drop_columns", "0011_extra", "0012_drop_extra"]);
    assert.deepEqual(await createDb([Team, Smaller], adapter).$sync({ dryRun: true }), [], "the tables match the models");
    const columns = (await db.$sql("SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'mm_notes'")).map((r) => r.c);
    assert.ok(!columns.includes("slug") && !columns.includes("owner_id"));
    assert.equal((await db.$sql("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'mm_extra'"))[0]!.n, 0);
  });

  test("a failing statement is IL4038 naming it; the statements before it stay applied and the file is not recorded", async () => {
    const sql = "CREATE TABLE `mm_partial` (`id` INT PRIMARY KEY);\nINSERT INTO `mm_missing` VALUES (1);\nCREATE TABLE `mm_never` (`id` INT)";
    await assert.rejects(applyMigrations(db, [{ name: "0003_partial", sql }]), (e: unknown) => {
      assert.ok(isCode("IL4038")(e));
      assert.match((e as Error).message, /0003_partial failed at statement 2 of 3/);
      assert.deepEqual((e as InferloError).details, { migration: "0003_partial", statement: 2, sql: "INSERT INTO `mm_missing` VALUES (1)" });
      return true;
    });
    assert.equal((await db.$sql("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('mm_partial', 'mm_never')"))[0]!.n, 1);
    assert.equal((await db.$sql("SELECT COUNT(*) AS n FROM `inferlo_migrations` WHERE `name` = '0003_partial'"))[0]!.n, 0);
    // The lock was released: the fixed file applies.
    assert.deepEqual(await applyMigrations(db, [{ name: "0003_partial", sql: "CREATE TABLE `mm_never` (`id` INT)" }]), ["0003_partial"]);
  });
});

if (MYSQL_URL) {
  describe("inferlo db migrate (CLI, mysql)", () => {
    const name = `inferlo_t_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const base = new URL(MYSQL_URL!);
    const url = `${base.protocol}//${base.username}:${base.password}@${base.host}/${name}`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "inferlo-migrate-mysql-"));
    const admin = async (sql: string) => {
      const { createConnection } = (await import("mysql2/promise")) as typeof import("mysql2/promise");
      const conn = await createConnection({ uri: MYSQL_URL! });
      await conn.query(sql);
      await conn.end();
    };
    const writeApp = (models: string) => {
      const index = JSON.stringify(path.join(repo, "src", "index.ts"));
      const mysql = JSON.stringify(path.join(repo, "src", "db", "mysql.ts"));
      writeFileSync(
        path.join(dir, "src", "app.ts"),
        `import { createApp, model, t } from ${index};\nimport { mysql } from ${mysql};\n${models}\nexport const app = createApp({ models, routes: [], db: mysql({ url: ${JSON.stringify(url)} }), logger: { info() {}, error() {} } });\n`,
      );
    };
    after(async () => {
      rmSync(dir, { recursive: true, force: true });
      await admin(`DROP DATABASE IF EXISTS \`${name}\``);
    });
    const cli = (...args: string[]) => spawnSync("node", [path.join(repo, "src", "cli", "main.ts"), ...args, "--json"], { cwd: dir, encoding: "utf8" });

    test("writes MySQL migration files and applies them", async () => {
      await admin(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
      writeApp('const models = [model("cli_notes", { title: t.string().max(80) })];');
      const r1 = cli("db", "migrate", "init");
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(JSON.parse(r1.stdout).file, "migrations/0001_init.sql");
      assert.match(readFileSync(path.join(dir, "migrations", "0001_init.sql"), "utf8"), /CREATE TABLE IF NOT EXISTS `cli_notes`/);
      assert.equal(JSON.parse(readFileSync(path.join(dir, "migrations", "snapshot.json"), "utf8")).dialect, "mysql");

      writeApp('const models = [model("cli_notes", { title: t.string().max(80), done: t.boolean().default(false) })];');
      const r2 = cli("db", "migrate", "add_done");
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(JSON.parse(r2.stdout).statements, ["ALTER TABLE `cli_notes` ADD COLUMN `done` BOOLEAN DEFAULT FALSE NOT NULL"]);
      assert.deepEqual(readdirSync(path.join(dir, "migrations")).sort(), ["0001_init.sql", "0002_add_done.sql", "snapshot.json"]);

      const r3 = cli("db", "migrate", "--apply");
      assert.equal(r3.status, 0, r3.stderr);
      assert.deepEqual(JSON.parse(r3.stdout), { ok: true, applied: ["0001_init", "0002_add_done"], edited: [] });
      const r4 = cli("db", "migrate", "--apply");
      assert.deepEqual(JSON.parse(r4.stdout), { ok: true, applied: [], edited: [] });
    });
  });
}
