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

  test("drops and column changes are refused and listed (KR4013)", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(120) });
    assert.throws(
      () => planMigration([Author2], first.snapshot),
      (e: unknown) => {
        if (!(e instanceof KairoError) || e.code !== "KR4013") return false;
        const changes = (e.details as { changes: string[] }).changes;
        return changes.includes("drop table posts") && changes.includes("drop column authors.email") && changes.includes("change column authors.name");
      },
    );
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
    writeModels(["done: t.boolean().default(false)"]);
    const r = cli("db", "migrate", "drop title");
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, "KR4013");
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 3);
  });

  test("--apply on memory() explains that Postgres is needed", () => {
    const r = cli("db", "migrate", "--apply");
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, "KR4008");
  });
});
