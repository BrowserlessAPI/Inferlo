import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { applyMigrations, createDb, KairoError, memory, model, planMigration, t } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { Author, Post, models } from "./helpers.ts";

const PG_URL = process.env.KAIRO_TEST_DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("planMigration", () => {
  test("first migration creates every table, referenced tables first", () => {
    const plan = planMigration([Post, Author]);
    assert.match(plan.statements[0]!, /^CREATE TABLE IF NOT EXISTS "authors"/);
    assert.ok(plan.statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "posts"')));
    assert.ok(plan.statements.some((s) => s.includes('"authors_email_key"')));
    assert.ok(plan.statements.some((s) => s.includes('"posts_author_id_idx"')));
    assert.deepEqual(Object.keys(plan.snapshot.tables).sort(), ["authors", "posts"]);
    assert.equal(plan.snapshot.kairo, 1);
  });

  test("no changes means no statements", () => {
    const first = planMigration(models);
    const second = planMigration(models, first.snapshot);
    assert.deepEqual(second.statements, []);
    assert.deepEqual(second.snapshot, first.snapshot);
  });

  test("new columns, tables and indexes become additive statements", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80).index(), email: t.email().unique(), bio: t.text().optional(), score: t.int().default(0) });
    const Tag = model("tags", { label: t.string().max(30) });
    const plan = planMigration([Author2, Post, Tag], first.snapshot);
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "bio" text',
      'ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "score" integer DEFAULT 0 NOT NULL',
      'CREATE INDEX IF NOT EXISTS "authors_name_idx" ON "authors" ("name")',
      'CREATE TABLE IF NOT EXISTS "tags" (\n  "id" uuid PRIMARY KEY,\n  "created_at" timestamptz NOT NULL DEFAULT now(),\n  "updated_at" timestamptz NOT NULL DEFAULT now(),\n  "label" varchar(30) NOT NULL\n)',
    ]);
    assert.deepEqual(planMigration([Author2, Post, Tag], plan.snapshot).statements, []);
  });

  test("a new required column without a default on an existing table is refused (KR4014)", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80), email: t.email().unique(), country: t.string() });
    assert.throws(
      () => planMigration([Author2, Post], first.snapshot),
      (e: unknown) => e instanceof KairoError && e.code === "KR4014" && /authors\.country/.test(e.message) && /default|optional/.test(e.fix ?? ""),
    );
  });

  test("column changes are refused and listed (KR4013), even with allowDrop", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(120) });
    for (const options of [undefined, { allowDrop: true }]) {
      assert.throws(
        () => planMigration([Author2], first.snapshot, options),
        (e: unknown) => {
          if (!(e instanceof KairoError) || e.code !== "KR4013") return false;
          const changes = (e.details as { changes: string[] }).changes;
          return changes.includes("change column authors.name") && !changes.some((c) => c.startsWith("drop"));
        },
      );
    }
  });

  test("drops need allowDrop and are refused otherwise (KR4017)", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80) });
    assert.throws(
      () => planMigration([Author2], first.snapshot),
      (e: unknown) => {
        if (!(e instanceof KairoError) || e.code !== "KR4017") return false;
        const drops = (e.details as { drops: string[] }).drops;
        return (
          drops.includes("drop table posts") &&
          drops.includes("drop column authors.email") &&
          drops.includes("drop index authors_email_key") &&
          /--allow-drop/.test(e.fix ?? "")
        );
      },
    );
  });

  test("allowDrop generates drops of indexes, columns and tables", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80), bio: t.text().optional() });
    const plan = planMigration([Author2], first.snapshot, { allowDrop: true });
    assert.deepEqual(plan.statements, [
      'DROP INDEX IF EXISTS "authors_email_key"',
      'ALTER TABLE "authors" DROP COLUMN IF EXISTS "email"',
      'ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "bio" text',
      'DROP TABLE IF EXISTS "posts"',
    ]);
    assert.deepEqual(plan.drops, ["drop column authors.email", "drop index authors_email_key", "drop table posts"]);
    assert.deepEqual(Object.keys(plan.snapshot.tables), ["authors"]);
    assert.deepEqual(planMigration([Author2], plan.snapshot).statements, []);
    assert.deepEqual(planMigration([Author2], plan.snapshot).drops, []);
  });

  test("dropping only an index (unique removed) and several tables at once", () => {
    const A = model("a_items", { code: t.string().max(10).unique() });
    const B = model("b_items", { aId: t.ref("a_items") });
    const C = model("c_items", { label: t.string().max(10) });
    const first = planMigration([A, B, C]);
    const A2 = model("a_items", { code: t.string().max(10).index() });
    assert.throws(() => planMigration([A2, C], first.snapshot), (e: unknown) => e instanceof KairoError && e.code === "KR4017");
    const plan = planMigration([A2, C], first.snapshot, { allowDrop: true });
    assert.deepEqual(plan.statements, [
      'DROP INDEX IF EXISTS "a_items_code_key"',
      'CREATE INDEX IF NOT EXISTS "a_items_code_idx" ON "a_items" ("code")',
      'DROP TABLE IF EXISTS "b_items"',
    ]);
  });

  test("an invalid snapshot is rejected (KR4015)", () => {
    assert.throws(() => planMigration(models, { kairo: 99, tables: {} } as never), (e: unknown) => e instanceof KairoError && e.code === "KR4015");
  });
});

describe("applyMigrations", () => {
  test("needs a database with raw SQL (memory is rejected with KR4008)", async () => {
    const db = createDb(models, memory());
    await assert.rejects(applyMigrations(db, [{ name: "0001_init", sql: "select 1" }]), (e: unknown) => e instanceof KairoError && e.code === "KR4008");
  });

  test("rejects bad migration names (KR4016)", async () => {
    const db = createDb(models, memory());
    await assert.rejects(applyMigrations(db, [{ name: "../evil", sql: "select 1" }]), (e: unknown) => e instanceof KairoError && e.code === "KR4016");
  });
});

if (PG_URL) {
  // Own table names, because test files run in parallel against the same database.
  describe("applyMigrations (postgres)", () => {
    const MigUser = model("mig_users", { email: t.email().unique() });
    const MigTag = model("mig_tags", { label: t.string().max(30), userId: t.ref("mig_users") });
    const db = createDb([MigUser, MigTag], postgres({ url: PG_URL }));
    const reset = () => db.$sql('DROP TABLE IF EXISTS "mig_tags", "mig_users", "half_done", "kairo_migrations" CASCADE');
    before(reset);
    after(async () => {
      await reset();
      await db.$close();
    });

    test("applies pending migrations once, in order, and records them", async () => {
      const first = planMigration([MigUser]);
      const second = planMigration([MigUser, MigTag], first.snapshot);
      const files = [
        { name: "0002_tags", sql: second.statements.join(";\n\n") + ";\n" },
        { name: "0001_init", sql: first.statements.join(";\n\n") + ";\n" },
      ];
      assert.deepEqual(await applyMigrations(db, files), ["0001_init", "0002_tags"]);
      assert.deepEqual(await applyMigrations(db, files), []);
      const rows = await db.$sql('SELECT name FROM "kairo_migrations" ORDER BY name');
      assert.deepEqual(rows.map((r) => r.name), ["0001_init", "0002_tags"]);
      const u = await db.mig_users.insert({ email: "m@example.com" });
      const tag = await db.mig_tags.insert({ label: "x", userId: u.id });
      assert.equal(tag.userId, u.id);
    });

    test("an allowDrop migration drops the column and table", async () => {
      const first = planMigration([MigUser, MigTag]);
      const MigUser2 = model("mig_users", { email: t.email() });
      const dropPlan = planMigration([MigUser2], first.snapshot, { allowDrop: true });
      await applyMigrations(db, [{ name: "0004_drops", sql: dropPlan.statements.join(";\n\n") + ";\n" }]);
      const tables = await db.$sql(`SELECT 1 FROM information_schema.tables WHERE table_name = 'mig_tags'`);
      assert.equal(tables.length, 0);
      const indexes = await db.$sql(`SELECT 1 FROM pg_indexes WHERE indexname = 'mig_users_email_key'`);
      assert.equal(indexes.length, 0);
    });

    test("warns (onEdited) about applied files that were edited since, and still applies the rest", async () => {
      const first = [{ name: "0010_edit", sql: "SELECT 1;\n" }];
      assert.deepEqual(await applyMigrations(db, first), ["0010_edit"]);
      const calls: string[][] = [];
      const onEdited = (names: string[]) => calls.push(names);
      // Same content with Windows line endings is not an edit.
      assert.deepEqual(await applyMigrations(db, [{ name: "0010_edit", sql: "SELECT 1;\r\n" }], { onEdited }), []);
      assert.deepEqual(calls, []);
      const edited = [
        { name: "0010_edit", sql: "SELECT 2;\n" },
        { name: "0011_next", sql: "SELECT 3;\n" },
      ];
      assert.deepEqual(await applyMigrations(db, edited, { onEdited }), ["0011_next"]);
      assert.deepEqual(calls, [["0010_edit"]]);
      // The recorded checksum is the applied one: the warning repeats until the file is restored.
      await applyMigrations(db, edited, { onEdited });
      assert.deepEqual(calls, [["0010_edit"], ["0010_edit"]]);
      await applyMigrations(db, [...first, edited[1]!], { onEdited });
      assert.equal(calls.length, 2);
    });

    test("a kairo_migrations table from 0.2 gets a checksum column, filled on the next run", async () => {
      await db.$sql('DROP TABLE IF EXISTS "kairo_migrations"');
      await db.$sql('CREATE TABLE "kairo_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())');
      await db.$sql(`INSERT INTO "kairo_migrations" ("name") VALUES ('0020_old')`);
      const calls: string[][] = [];
      const onEdited = (names: string[]) => calls.push(names);
      assert.deepEqual(await applyMigrations(db, [{ name: "0020_old", sql: "SELECT 1;" }], { onEdited }), []);
      assert.deepEqual(calls, []);
      const rows = await db.$sql(`SELECT "checksum" FROM "kairo_migrations" WHERE "name" = '0020_old'`);
      assert.match(String(rows[0]?.checksum), /^[0-9a-f]{64}$/);
      await applyMigrations(db, [{ name: "0020_old", sql: "SELECT 2;" }], { onEdited });
      assert.deepEqual(calls, [["0020_old"]]);
    });

    test("a failing migration is rolled back and not recorded", async () => {
      const files = [{ name: "0003_broken", sql: 'CREATE TABLE "half_done" ("x" int);\nSELECT * FROM "does_not_exist";' }];
      await assert.rejects(applyMigrations(db, files));
      const rows = await db.$sql(`SELECT name FROM "kairo_migrations" WHERE name = '0003_broken'`);
      assert.equal(rows.length, 0);
      const tables = await db.$sql(`SELECT 1 FROM information_schema.tables WHERE table_name = 'half_done'`);
      assert.equal(tables.length, 0);
    });
  });
}

if (PG_URL) {
  describe("kairo db migrate --apply (CLI, postgres)", () => {
    let dir = "";
    const pgDb = createDb([], postgres({ url: PG_URL }));
    const reset = () => pgDb.$sql('DROP TABLE IF EXISTS "cli_mig_notes", "kairo_migrations" CASCADE');
    before(async () => {
      await reset();
      dir = mkdtempSync(path.join(os.tmpdir(), "kairo-migrate-pg-"));
      mkdirSync(path.join(dir, "src"));
      mkdirSync(path.join(dir, "migrations"));
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
      const index = JSON.stringify(path.join(repo, "src", "index.ts"));
      const pg = JSON.stringify(path.join(repo, "src", "db", "postgres.ts"));
      writeFileSync(
        path.join(dir, "src", "app.ts"),
        `import { createApp } from ${index};\nimport { postgres } from ${pg};\nexport const app = createApp({ models: [], routes: [], db: postgres({ url: ${JSON.stringify(PG_URL)} }), logger: { info() {}, error() {} } });\n`,
      );
    });
    after(async () => {
      rmSync(dir, { recursive: true, force: true });
      await reset();
      await pgDb.$close();
    });
    const cli = (...args: string[]) => spawnSync("node", [path.join(repo, "src", "cli", "main.ts"), ...args], { cwd: dir, encoding: "utf8" });

    test("lists edited files in edited and warns with KR4018", () => {
      const file = path.join(dir, "migrations", "0001_init.sql");
      writeFileSync(file, 'CREATE TABLE IF NOT EXISTS "cli_mig_notes" ("id" uuid PRIMARY KEY);\n');
      const r1 = cli("db", "migrate", "--apply", "--json");
      assert.equal(r1.status, 0, r1.stderr);
      assert.deepEqual(JSON.parse(r1.stdout), { ok: true, applied: ["0001_init"], edited: [] });

      writeFileSync(file, 'CREATE TABLE IF NOT EXISTS "cli_mig_notes" ("id" uuid PRIMARY KEY, "title" text);\n');
      const r2 = cli("db", "migrate", "--apply", "--json");
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(JSON.parse(r2.stdout), { ok: true, applied: [], edited: ["0001_init"] });

      const r3 = cli("db", "migrate", "--apply");
      assert.equal(r3.status, 0, r3.stderr);
      assert.match(r3.stderr, /KR4018/);
      assert.match(r3.stderr, /migrations\/0001_init\.sql/);
      assert.match(r3.stdout, /No pending migrations/);
    });
  });
}

describe("kairo db migrate (CLI)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "kairo-migrate-"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeModels(["title: t.string().max(100)"]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const writeModels = (fields: string[]) => {
    const index = JSON.stringify(path.join(repo, "src", "index.ts"));
    writeFileSync(
      path.join(dir, "src", "app.ts"),
      `import { createApp, memory, model, t } from ${index};\nexport const Note = model("notes", { ${fields.join(", ")} });\nexport const app = createApp({ models: [Note], routes: [], db: memory(), logger: { info() {}, error() {} } });\n`,
    );
  };
  const cli = (...args: string[]) => {
    const r = spawnSync("node", [path.join(repo, "src", "cli", "main.ts"), ...args, "--json"], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") };
  };

  test("generates numbered files and a snapshot, and nothing when unchanged", () => {
    const r1 = cli("db", "migrate", "init");
    assert.equal(r1.status, 0, JSON.stringify(r1.out));
    assert.equal(r1.out.file, "migrations/0001_init.sql");
    assert.match(readFileSync(path.join(dir, "migrations", "0001_init.sql"), "utf8"), /CREATE TABLE IF NOT EXISTS "notes"/);
    assert.ok(existsSync(path.join(dir, "migrations", "snapshot.json")));

    const r2 = cli("db", "migrate");
    assert.equal(r2.status, 0);
    assert.equal(r2.out.file, null);
    assert.deepEqual(r2.out.statements, []);

    writeModels(["title: t.string().max(100)", "done: t.boolean().default(false)"]);
    const dry = cli("db", "migrate", "add done", "--dry-run");
    assert.equal(dry.out.file, null);
    assert.deepEqual(dry.out.statements, ['ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "done" boolean DEFAULT false NOT NULL']);
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 2);

    const r3 = cli("db", "migrate", "add done");
    assert.equal(r3.out.file, "migrations/0002_add_done.sql");
    assert.deepEqual(readdirSync(path.join(dir, "migrations")).sort(), ["0001_init.sql", "0002_add_done.sql", "snapshot.json"]);
  });

  test("refused changes exit non-zero and write nothing", () => {
    writeModels(["title: t.string().max(200)", "done: t.boolean().default(false)"]);
    const r = cli("db", "migrate", "widen title");
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, "KR4013");
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 3);
  });

  test("drops need --allow-drop (KR4017), then are written and listed", () => {
    writeModels(["done: t.boolean().default(false)"]);
    const refused = cli("db", "migrate", "drop title");
    assert.equal(refused.status, 1);
    assert.equal(refused.out.error.code, "KR4017");
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 3);

    const r = cli("db", "migrate", "drop title", "--allow-drop");
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.equal(r.out.file, "migrations/0003_drop_title.sql");
    assert.deepEqual(r.out.drops, ["drop column notes.title"]);
    const sql = readFileSync(path.join(dir, "migrations", "0003_drop_title.sql"), "utf8");
    assert.match(sql, /ALTER TABLE "notes" DROP COLUMN IF EXISTS "title"/);
    assert.match(sql, /deletes data/);
    assert.deepEqual(cli("db", "migrate").out.statements, []);
  });

  test("--apply on memory() explains that Postgres is needed", () => {
    const r = cli("db", "migrate", "--apply");
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, "KR4008");
  });
});
