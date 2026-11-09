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

type AnyModelLike = ReturnType<typeof model>;
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

  test("a new required column without a default is IL4014", () => {
    const first = planMigration([Team, Note], undefined, { dialect: "mysql" });
    const required = model("mm_notes", { title: t.string().max(100), body: t.text().default(""), teamId: t.ref("mm_teams", { onDelete: "cascade" }), rank: t.int() });
    assert.throws(() => planMigration([Team, required], first.snapshot, { dialect: "mysql" }), isCode("IL4014"));
  });

  test("column changes need allowChange (IL4019) and become MODIFY COLUMN with the CHECK and foreign key replaced", () => {
    const first = planMigration([Team, NoteV2], undefined, { dialect: "mysql" });
    const Changed = model("mm_notes", {
      title: t.string().max(200),
      body: t.text().optional(),
      teamId: t.ref("mm_teams", { onDelete: "restrict" }),
      status: t.enum(["open", "done", "archived"]).default("open"),
      slug: t.string().max(80).default("none").index(),
      ownerId: t.ref("mm_teams").optional(),
      tags: t.array(t.string()).default([]),
    });
    assert.throws(
      () => planMigration([Team, Changed], first.snapshot, { dialect: "mysql" }),
      (e: unknown) => isCode("IL4019")(e) && /change column mm_notes\.title \(type VARCHAR\(100\) -> VARCHAR\(200\)\)/.test((e as Error).message) && /allow-change/.test((e as InferloError).fix!),
    );
    const plan = planMigration([Team, Changed], first.snapshot, { dialect: "mysql", allowChange: true });
    const dropCheck = plan.statements.find((s) => s.startsWith("SET @inferlo_sql"))!;
    assert.match(dropCheck, /tc\.TABLE_NAME = 'mm_notes'/);
    assert.match(dropCheck, /LIKE '\(`status` in \(%'/);
    assert.deepEqual(plan.statements, [
      "ALTER TABLE `mm_notes` MODIFY COLUMN `title` VARCHAR(200) NOT NULL",
      "ALTER TABLE `mm_notes` MODIFY COLUMN `body` MEDIUMTEXT NULL",
      "ALTER TABLE `mm_notes` DROP FOREIGN KEY `mm_notes_team_id_fkey`",
      dropCheck,
      "PREPARE inferlo_stmt FROM @inferlo_sql",
      "EXECUTE inferlo_stmt",
      "DEALLOCATE PREPARE inferlo_stmt",
      "ALTER TABLE `mm_notes` ADD CHECK (`status` IN ('open', 'done', 'archived'))",
      "UPDATE `mm_notes` SET `slug` = 'none' WHERE `slug` IS NULL",
      "ALTER TABLE `mm_notes` MODIFY COLUMN `slug` VARCHAR(80) DEFAULT 'none' NOT NULL",
      "ALTER TABLE `mm_notes` ADD CONSTRAINT `mm_notes_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `mm_teams` (`id`) ON DELETE RESTRICT",
    ]);
    assert.equal(plan.changes.length, 5);
    assert.deepEqual(planMigration([Team, Changed], plan.snapshot, { dialect: "mysql" }).statements, [], "nothing changed after the plan");
  });

  test("type changes MySQL would convert silently or differently are IL4013", () => {
    const Numbers = model("mm_nums", { n: t.number(), flag: t.boolean(), data: t.json(), title: t.string().max(10).index() });
    const first = planMigration([Numbers], undefined, { dialect: "mysql" });
    for (const [field, schema] of [["n", t.int()], ["flag", t.string()], ["data", t.string()]] as const) {
      const changed = model("mm_nums", { ...Numbers.fields, [field]: schema });
      assert.throws(
        () => planMigration([changed], first.snapshot, { dialect: "mysql", allowChange: true }),
        (e: unknown) => isCode("IL4013")(e) && new RegExp(`change column mm_nums\\.${field} \\(type`).test((e as Error).message) && /converts the others silently/.test((e as InferloError).fix!),
      );
    }
    const unique = model("mm_nums", { ...Numbers.fields, title: t.string().max(10).unique() });
    assert.deepEqual(planMigration([unique], first.snapshot, { dialect: "mysql", allowDrop: true }).statements, ["DROP INDEX `mm_nums_title_idx` ON `mm_nums`", "CREATE UNIQUE INDEX `mm_nums_title_key` ON `mm_nums` (`title`)"]);
    const widened = model("mm_nums", { ...Numbers.fields, n: t.string(), title: t.text().optional() });
    assert.doesNotThrow(() => planMigration([widened], first.snapshot, { dialect: "mysql", allowChange: true, allowDrop: true }));
  });

  test("renames become RENAME TO, RENAME COLUMN and RENAME INDEX; foreign keys and CHECK constraints are re-created", () => {
    const Owner = model("mr_owners", { name: t.string().max(40) });
    const Item = model("mr_items", { color: t.enum(["red", "blue"]).default("red"), dueAt: t.date().optional().index(), ownerId: t.ref("mr_owners").optional(), code: t.string().max(10).unique() });
    const first = planMigration([Owner, Item], undefined, { dialect: "mysql" });
    const Renamed = model("mr_things", { colour: t.enum(["red", "blue"]).default("red"), deadlineAt: t.date().optional().index(), holderId: t.ref("mr_owners").optional(), code: t.string().max(10).unique() });
    assert.throws(() => planMigration([Owner, Renamed], first.snapshot, { dialect: "mysql", allowDrop: false }), (e: unknown) => isCode("IL4017")(e) && /--rename mr_items=mr_things/.test((e as InferloError).fix!));
    const plan = planMigration([Owner, Renamed], first.snapshot, { dialect: "mysql", renames: { mr_items: "mr_things", "mr_items.color": "mr_things.colour", "mr_items.dueAt": "mr_things.deadlineAt", "mr_items.owner_id": "mr_things.holder_id" } });
    const dropCheck = plan.statements.find((s) => s.startsWith("SET @inferlo_sql"))!;
    assert.match(dropCheck, /tc\.TABLE_NAME = 'mr_things'/);
    assert.match(dropCheck, /LIKE '\(`color` in \(%'/);
    assert.deepEqual(plan.statements, [
      "ALTER TABLE `mr_items` RENAME TO `mr_things`",
      dropCheck,
      "PREPARE inferlo_stmt FROM @inferlo_sql",
      "EXECUTE inferlo_stmt",
      "DEALLOCATE PREPARE inferlo_stmt",
      "ALTER TABLE `mr_things` RENAME COLUMN `color` TO `colour`",
      "ALTER TABLE `mr_things` ADD CHECK (`colour` IN ('red', 'blue'))",
      "ALTER TABLE `mr_things` RENAME COLUMN `due_at` TO `deadline_at`",
      "ALTER TABLE `mr_things` RENAME COLUMN `owner_id` TO `holder_id`",
      "ALTER TABLE `mr_things` RENAME INDEX `mr_items_code_key` TO `mr_things_code_key`",
      "ALTER TABLE `mr_things` RENAME INDEX `mr_items_due_at_idx` TO `mr_things_deadline_at_idx`",
      "ALTER TABLE `mr_things` DROP FOREIGN KEY `mr_items_owner_id_fkey`",
      "ALTER TABLE `mr_things` RENAME INDEX `mr_items_owner_id_fkey` TO `mr_things_holder_id_fkey`",
      "ALTER TABLE `mr_things` ADD CONSTRAINT `mr_things_holder_id_fkey` FOREIGN KEY (`holder_id`) REFERENCES `mr_owners` (`id`) ON DELETE RESTRICT",
    ]);
    assert.deepEqual(plan.renames, ["rename table mr_items -> mr_things", "rename column mr_items.color -> mr_things.colour", "rename column mr_items.due_at -> mr_things.deadline_at", "rename column mr_items.owner_id -> mr_things.holder_id"]);
    assert.deepEqual(planMigration([Owner, Renamed], plan.snapshot, { dialect: "mysql" }).statements, [], "the snapshot matches the models");
    assert.throws(() => planMigration([Owner, Renamed], first.snapshot, { dialect: "mysql", renames: { mr_nope: "mr_things" } }), isCode("IL4032"));
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
    assert.throws(() => planMigration([Team, Renamed], first.snapshot, { dialect: "mysql" }), (e: unknown) => isCode("IL4017")(e) && /--rename mm_notes\.title=mm_notes\.headline/.test((e as InferloError).fix!));
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

  test("generated column changes and renames apply and keep the data", async () => {
    const own = createDb([], mysqlAdapter());
    try {
      const Owner = model("mx_owners", { name: t.string().max(40) });
      const Item = model("mx_items", {
        color: t.enum(["red", "blue"]).default("red"),
        size: t.int().optional(),
        title: t.string().max(20),
        dueAt: t.date().optional().index(),
        ownerId: t.ref("mx_owners").optional(),
        code: t.string().max(10).unique(),
      });
      const v1 = planMigration([Owner, Item], undefined, { dialect: "mysql" });
      await applyMigrations(own, [{ name: "0001_init", sql: file(v1.statements) }]);
      const typed1 = createDb([Owner, Item], own.$adapter);
      const owner = await typed1.mx_owners.insert({ name: "Ann" });
      const item = await typed1.mx_items.insert({ color: "blue", title: "Lamp", ownerId: owner.id, code: "L1" });
      await typed1.mx_items.insert({ title: "Desk", code: "D1", size: 3 });

      const Changed = model("mx_items", {
        color: t.enum(["red", "blue", "green"]).default("blue"),
        size: t.number().default(1),
        title: t.string().max(80),
        dueAt: t.date().optional().index(),
        ownerId: t.ref("mx_owners", { onDelete: "set null" }).optional(),
        code: t.string().max(10).unique(),
      });
      const v2 = planMigration([Owner, Changed], v1.snapshot, { dialect: "mysql", allowChange: true });
      const Renamed = model("mx_things", {
        colour: t.enum(["red", "blue", "green"]).default("blue"),
        size: t.number().default(1),
        title: t.string().max(80),
        deadlineAt: t.date().optional().index(),
        holderId: t.ref("mx_owners", { onDelete: "set null" }).optional(),
        code: t.string().max(10).unique(),
      });
      const v3 = planMigration([Owner, Renamed], v2.snapshot, { dialect: "mysql", renames: { mx_items: "mx_things", "mx_items.color": "mx_things.colour", "mx_items.due_at": "mx_things.deadline_at", "mx_items.owner_id": "mx_things.holder_id" } });
      assert.deepEqual(await applyMigrations(own, [{ name: "0001_init", sql: file(v1.statements) }, { name: "0002_change", sql: file(v2.statements) }, { name: "0003_rename", sql: file(v3.statements) }]), ["0002_change", "0003_rename"]);

      const typed = createDb([Owner, Renamed], own.$adapter);
      assert.deepEqual(await typed.$sync({ dryRun: true }), [], "the migrated tables match what db push would create");
      const lamp = await typed.mx_things.findOne({ id: item.id });
      assert.equal(lamp?.colour, "blue");
      assert.equal(lamp?.holderId, owner.id);
      assert.equal(lamp?.size, 1, "NULL sizes got the new default");
      const added = await typed.mx_things.insert({ title: "A title longer than twenty characters", code: "X1", colour: "green" });
      assert.equal(added.size, 1);
      await assert.rejects(typed.mx_things.insert({ title: "Bad", code: "B1", colour: "pink" as "red" }));
      await assert.rejects(typed.mx_things.insert({ title: "Dup", code: "L1" }), isCode("IL4004"));
      await assert.rejects(typed.mx_things.insert({ title: "Orphan", code: "O1", holderId: crypto.randomUUID() }), isCode("IL4011"));
      await typed.mx_owners.delete(owner.id);
      assert.equal((await typed.mx_things.findOne({ id: item.id }))?.holderId ?? null, null, "ON DELETE SET NULL now applies");
      const checks = await own.$sql("SELECT COUNT(*) AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()");
      assert.equal(Number(checks[0]!.n), 1, "one CHECK constraint is left for the enum column");
      const keys = (await own.$sql("SELECT CONSTRAINT_NAME AS c FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'")).map((r) => r.c);
      assert.deepEqual(keys, ["mx_things_holder_id_fkey"]);

      // Dropping the renamed reference finds its foreign key under the new name.
      const { holderId: _removed, ...rest } = Renamed.fields;
      const Without = model("mx_things", rest);
      const v4 = planMigration([Owner, Without], v3.snapshot, { dialect: "mysql", allowDrop: true });
      assert.deepEqual(await applyMigrations(own, [{ name: "0004_drop", sql: file(v4.statements) }]), ["0004_drop"]);
    } finally {
      await own.$close();
    }
  });

  test("changes the data does not allow fail at apply time with IL4038", async () => {
    const own = createDb([], mysqlAdapter());
    try {
      const Row = model("mf_rows", { state: t.enum(["a", "b"]).default("a"), label: t.string().max(20).optional(), num: t.string().max(20) });
      const v1 = planMigration([Row], undefined, { dialect: "mysql" });
      await applyMigrations(own, [{ name: "0001_init", sql: file(v1.statements) }]);
      await createDb([Row], own.$adapter).mf_rows.insert({ state: "b", num: "abc" });
      const cases: [string, AnyModelLike][] = [
        ["removed enum value in use", model("mf_rows", { ...Row.fields, state: t.enum(["a"]).default("a") })],
        ["NULL left in a required column", model("mf_rows", { ...Row.fields, label: t.string().max(20) })],
        ["a value that does not convert", model("mf_rows", { ...Row.fields, num: t.int() })],
      ];
      for (const [name, changed] of cases) {
        const plan = planMigration([changed], v1.snapshot, { dialect: "mysql", allowChange: true });
        await assert.rejects(applyMigrations(own, [{ name: "0002_bad", sql: file(plan.statements) }]), isCode("IL4038"), name);
      }
    } finally {
      await own.$close();
    }
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
