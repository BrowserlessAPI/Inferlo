import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { applyMigrations, createDb, InferloError, memory, model, planMigration, t, type MigrationSnapshotV1 } from "../src/index.ts";
import { columnDefinition, modelIndexes, postgres, SYSTEM_COLUMNS } from "../src/db/postgres.ts";
import { columnName, type AnyModel } from "../src/model.ts";
import type { AnySchema } from "../src/schema.ts";
import { Author, Post, models } from "./helpers.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("planMigration", () => {
  test("first migration creates every table, referenced tables first", () => {
    const plan = planMigration([Post, Author]);
    assert.match(plan.statements[0]!, /^CREATE TABLE IF NOT EXISTS "authors"/);
    assert.ok(plan.statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "posts"')));
    assert.ok(plan.statements.some((s) => s.includes('"authors_email_key"')));
    assert.ok(plan.statements.some((s) => s.includes('"posts_author_id_idx"')));
    assert.deepEqual(Object.keys(plan.snapshot.tables).sort(), ["authors", "posts"]);
    assert.equal(plan.snapshot.inferlo, 2);
  });

  test("a snapshot written before the rename from Kairo (key \"kairo\") is still read", () => {
    const first = planMigration(models);
    const { inferlo, ...rest } = first.snapshot;
    const legacy = { ...rest, kairo: inferlo };
    const second = planMigration(models, legacy as never);
    assert.deepEqual(second.statements, []);
    assert.equal(second.snapshot.inferlo, 2);
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

  test("a new required column without a default on an existing table is refused (IL4014)", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80), email: t.email().unique(), country: t.string() });
    assert.throws(
      () => planMigration([Author2, Post], first.snapshot),
      (e: unknown) => e instanceof InferloError && e.code === "IL4014" && /authors\.country/.test(e.message) && /default|optional/.test(e.fix ?? ""),
    );
  });

  test("column changes are refused and listed (IL4013), even with allowDrop", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(120) });
    for (const options of [undefined, { allowDrop: true }]) {
      assert.throws(
        () => planMigration([Author2], first.snapshot, options),
        (e: unknown) => {
          if (!(e instanceof InferloError) || e.code !== "IL4013") return false;
          const changes = (e.details as { changes: string[] }).changes;
          return changes.includes("change column authors.name") && !changes.some((c) => c.startsWith("drop"));
        },
      );
    }
  });

  test("drops need allowDrop and are refused otherwise (IL4017)", () => {
    const first = planMigration(models);
    const Author2 = model("authors", { name: t.string().max(80) });
    assert.throws(
      () => planMigration([Author2], first.snapshot),
      (e: unknown) => {
        if (!(e instanceof InferloError) || e.code !== "IL4017") return false;
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
    assert.throws(() => planMigration([A2, C], first.snapshot), (e: unknown) => e instanceof InferloError && e.code === "IL4017");
    const plan = planMigration([A2, C], first.snapshot, { allowDrop: true });
    assert.deepEqual(plan.statements, [
      'DROP INDEX IF EXISTS "a_items_code_key"',
      'CREATE INDEX IF NOT EXISTS "a_items_code_idx" ON "a_items" ("code")',
      'DROP TABLE IF EXISTS "b_items"',
    ]);
  });

  test("an invalid snapshot is rejected (IL4015)", () => {
    assert.throws(() => planMigration(models, { inferlo: 99, tables: {} } as never), (e: unknown) => e instanceof InferloError && e.code === "IL4015");
    const bad = { inferlo: 2, tables: { authors: { columns: { name: "\"name\" text" }, indexes: {} } } };
    assert.throws(() => planMigration(models, bad as never), (e: unknown) => e instanceof InferloError && e.code === "IL4015");
    const badV1 = { inferlo: 1, tables: { authors: { columns: { name: "\"name\" text WHATEVER" }, indexes: {} } } };
    assert.throws(() => planMigration(models, badV1 as never), (e: unknown) => e instanceof InferloError && e.code === "IL4015");
  });
});

/** The snapshot format Inferlo 0.2.0 wrote: each column as its SQL definition. */
function v1Snapshot(list: readonly AnyModel[]): MigrationSnapshotV1 {
  const tables: MigrationSnapshotV1["tables"] = {};
  for (const m of list) {
    const columns: Record<string, string> = Object.fromEntries(SYSTEM_COLUMNS);
    for (const [field, schema] of Object.entries(m.fields as Record<string, AnySchema>)) columns[columnName(field)] = columnDefinition(m, field, schema);
    tables[m.name] = { columns, indexes: Object.fromEntries(modelIndexes(m)) };
  }
  return { inferlo: 1, tables };
}

describe("migration snapshot format (inferlo: 2)", () => {
  test("columns are stored as structured descriptions", () => {
    const { snapshot } = planMigration(models);
    const posts = snapshot.tables.posts!.columns;
    assert.deepEqual(posts.id, { type: "uuid", notNull: true, primaryKey: true });
    assert.deepEqual(posts.created_at, { type: "timestamptz", notNull: true, default: "now()" });
    assert.deepEqual(posts.title, { type: "varchar(120)", notNull: true });
    assert.deepEqual(posts.views, { type: "integer", notNull: true, default: "0" });
    assert.deepEqual(posts.rating, { type: "double precision", notNull: false });
    assert.deepEqual(posts.tags, { type: "jsonb", notNull: true });
    assert.deepEqual(posts.kind, { type: "text", notNull: true, default: "'note'", enum: ["note", "article"] });
    assert.deepEqual(posts.published_at, { type: "timestamptz", notNull: false });
    assert.deepEqual(posts.author_id, { type: "uuid", notNull: true, references: { table: "authors", onDelete: "cascade" } });
    const Settings = model("settings", { prefs: t.json<{ a: number }>().default({ a: 1 }), note: t.string().default("it's") });
    const s = planMigration([Settings]).snapshot.tables.settings!.columns;
    assert.deepEqual(s.prefs, { type: "jsonb", notNull: true, default: `'{"a":1}'::jsonb` });
    assert.deepEqual(s.note, { type: "text", notNull: true, default: "'it''s'" });
  });

  test("an inferlo: 1 snapshot is upgraded: unchanged models give no statements and an inferlo: 2 snapshot", () => {
    const Odd = model("odd_items", {
      label: t.string().max(40).default("a 'quoted', (odd) DEFAULT value NOT NULL"),
      state: t.enum(["it's", "a, b", "x)"]).default("x)"),
      ratio: t.number().default(-1.5),
      on: t.boolean().default(true),
      parent: t.ref("odd_items", { onDelete: "set null" }).optional(),
      extra: t.any(),
    });
    for (const list of [models, [Odd]] as const) {
      const fresh = planMigration(list);
      const upgraded = planMigration(list, v1Snapshot(list));
      assert.deepEqual(upgraded.statements, []);
      assert.equal(upgraded.snapshot.inferlo, 2);
      assert.deepEqual(upgraded.snapshot, fresh.snapshot);
    }
  });

  test("an inferlo: 1 snapshot still plans additive changes and drops", () => {
    const Author2 = model("authors", { name: t.string().max(80), email: t.email().unique(), bio: t.text().optional() });
    assert.deepEqual(planMigration([Author2, Post], v1Snapshot(models)).statements, ['ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "bio" text']);
    assert.throws(() => planMigration([Author2], v1Snapshot(models)), (e: unknown) => e instanceof InferloError && e.code === "IL4017");
  });

  test("IL4013 says what changed in each column, for inferlo: 1 and inferlo: 2 snapshots", () => {
    const Post2 = model("posts", {
      ...Post.fields,
      title: t.string().min(1).max(200).default("Untitled"),
      authorId: t.ref("authors"),
    });
    for (const previous of [planMigration(models).snapshot, v1Snapshot(models)]) {
      for (const options of [undefined, { allowChange: true }]) {
        assert.throws(
          () => planMigration([Author, Post2], previous, options),
          (e: unknown) => {
            if (!(e instanceof InferloError) || e.code !== "IL4013") return false;
            const details = e.details as { changes: string[]; columns: { table: string; column: string; changes: string[] }[] };
            assert.deepEqual(details.changes, ["change column posts.title", "change column posts.author_id"]);
            assert.deepEqual(details.columns, [
              { table: "posts", column: "title", changes: ["type varchar(120) -> varchar(200)", "default none -> 'Untitled'"] },
              { table: "posts", column: "author_id", changes: ["reference authors on delete cascade -> authors on delete restrict"] },
            ]);
            assert.match(e.message, /posts\.title \(type varchar\(120\) -> varchar\(200\), default none -> 'Untitled'\)/);
            return true;
          },
        );
      }
    }
  });
});

describe("default and required changes (allowChange)", () => {
  const Post2 = model("posts", {
    ...Post.fields,
    views: t.int().default(1),
    rating: t.number().default(3),
    published: t.boolean(),
    body: t.text().optional(),
    meta: t.json<{ source?: string }>(),
  });

  test("are refused without allowChange (IL4019) and listed, for inferlo: 1 and inferlo: 2 snapshots", () => {
    for (const previous of [planMigration(models).snapshot, v1Snapshot(models)]) {
      assert.throws(
        () => planMigration([Author, Post2], previous, { allowDrop: true }),
        (e: unknown) => {
          if (!(e instanceof InferloError) || e.code !== "IL4019") return false;
          const details = e.details as { changes: string[]; columns: { table: string; column: string; changes: string[] }[] };
          assert.deepEqual(details.columns, [
            { table: "posts", column: "body", changes: ["required -> optional"] },
            { table: "posts", column: "views", changes: ["default 0 -> 1"] },
            { table: "posts", column: "rating", changes: ["optional -> required", "default none -> 3"] },
            { table: "posts", column: "published", changes: ["default false -> none"] },
            { table: "posts", column: "meta", changes: ["optional -> required"] },
          ]);
          assert.deepEqual(details.changes, [
            "change column posts.body (required -> optional)",
            "change column posts.views (default 0 -> 1)",
            "change column posts.rating (optional -> required, default none -> 3)",
            "change column posts.published (default false -> none)",
            "change column posts.meta (optional -> required)",
          ]);
          assert.match(e.message, /posts\.views \(default 0 -> 1\)/);
          assert.match(e.fix ?? "", /--allow-change/);
          return true;
        },
      );
    }
  });

  test("allowChange generates SET/DROP DEFAULT and SET/DROP NOT NULL, filling NULL rows with a new default", () => {
    const first = planMigration(models);
    const plan = planMigration([Author, Post2], first.snapshot, { allowChange: true });
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "posts" ALTER COLUMN "body" DROP NOT NULL',
      'ALTER TABLE "posts" ALTER COLUMN "views" SET DEFAULT 1',
      'ALTER TABLE "posts" ALTER COLUMN "rating" SET DEFAULT 3',
      'UPDATE "posts" SET "rating" = 3 WHERE "rating" IS NULL',
      'ALTER TABLE "posts" ALTER COLUMN "rating" SET NOT NULL',
      'ALTER TABLE "posts" ALTER COLUMN "published" DROP DEFAULT',
      'ALTER TABLE "posts" ALTER COLUMN "meta" SET NOT NULL',
    ]);
    assert.deepEqual(plan.changes, [
      "change column posts.body (required -> optional)",
      "change column posts.views (default 0 -> 1)",
      "change column posts.rating (optional -> required, default none -> 3)",
      "change column posts.published (default false -> none)",
      "change column posts.meta (optional -> required)",
    ]);
    assert.deepEqual(plan.drops, []);
    assert.deepEqual(plan.snapshot.tables.posts!.columns.rating, { type: "double precision", notNull: true, default: "3" });
    const again = planMigration([Author, Post2], plan.snapshot);
    assert.deepEqual(again.statements, []);
    assert.deepEqual(again.changes, []);
  });

  test("a function default counts as no database default", () => {
    const first = planMigration(models);
    const Post3 = model("posts", { ...Post.fields, kind: t.enum(["note", "article"]).default(() => "note" as const) });
    const plan = planMigration([Author, Post3], first.snapshot, { allowChange: true });
    assert.deepEqual(plan.statements, ['ALTER TABLE "posts" ALTER COLUMN "kind" DROP DEFAULT']);
  });
});

describe("enum value changes (allowChange)", () => {
  test("are refused without allowChange (IL4019) and listed, for inferlo: 1 and inferlo: 2 snapshots", () => {
    const Post2 = model("posts", { ...Post.fields, kind: t.enum(["note", "article", "page"]).default("note") });
    for (const previous of [planMigration(models).snapshot, v1Snapshot(models)]) {
      assert.throws(
        () => planMigration([Author, Post2], previous, { allowDrop: true }),
        (e: unknown) => {
          if (!(e instanceof InferloError) || e.code !== "IL4019") return false;
          assert.deepEqual((e.details as { changes: string[] }).changes, ["change column posts.kind (enum values 'note', 'article' -> 'note', 'article', 'page')"]);
          return true;
        },
      );
    }
  });

  test("allowChange replaces the CHECK constraint, named as Postgres names it", () => {
    const first = planMigration(models);
    const Post2 = model("posts", { ...Post.fields, kind: t.enum(["note", "page", "it's"]).default("page") });
    const plan = planMigration([Author, Post2], first.snapshot, { allowChange: true });
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "posts" DROP CONSTRAINT "posts_kind_check"',
      `ALTER TABLE "posts" ALTER COLUMN "kind" SET DEFAULT 'page'`,
      `ALTER TABLE "posts" ADD CONSTRAINT "posts_kind_check" CHECK ("kind" IN ('note', 'page', 'it''s'))`,
    ]);
    assert.deepEqual(plan.changes, [`change column posts.kind (default 'note' -> 'page', enum values 'note', 'article' -> 'note', 'page', 'it''s')`]);
    assert.deepEqual(plan.snapshot.tables.posts!.columns.kind, { type: "text", notNull: true, default: "'page'", enum: ["note", "page", "it's"] });
    assert.deepEqual(planMigration([Author, Post2], plan.snapshot).statements, []);
  });

  test("a text field becoming an enum gets a CHECK constraint, and an enum becoming text loses it", () => {
    const first = planMigration(models);
    const toEnum = model("posts", { ...Post.fields, body: t.enum(["a", "b"]) });
    assert.deepEqual(planMigration([Author, toEnum], first.snapshot, { allowChange: true }).statements, [
      `ALTER TABLE "posts" ADD CONSTRAINT "posts_body_check" CHECK ("body" IN ('a', 'b'))`,
    ]);
    const toText = model("posts", { ...Post.fields, kind: t.text().default("note") });
    assert.deepEqual(planMigration([Author, toText], first.snapshot, { allowChange: true }).statements, ['ALTER TABLE "posts" DROP CONSTRAINT "posts_kind_check"']);
  });

  test("long table and column names are shortened to 63 bytes the way Postgres does", () => {
    const table = "a_table_with_a_rather_long_name_for_testing";
    const Long = model(table, { theStatusOfThisParticularRow: t.enum(["x", "y"]) });
    const Long2 = model(table, { theStatusOfThisParticularRow: t.enum(["x", "y", "z"]) });
    const plan = planMigration([Long2], planMigration([Long]).snapshot, { allowChange: true });
    const name = "a_table_with_a_rather_long_n_the_status_of_this_particula_check";
    assert.equal(name.length, 63);
    assert.equal(plan.statements[0], `ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`);
  });
});

describe("applyMigrations", () => {
  test("needs a database with raw SQL (memory is rejected with IL4008)", async () => {
    const db = createDb(models, memory());
    await assert.rejects(applyMigrations(db, [{ name: "0001_init", sql: "select 1" }]), (e: unknown) => e instanceof InferloError && e.code === "IL4008");
  });

  test("rejects bad migration names (IL4016)", async () => {
    const db = createDb(models, memory());
    await assert.rejects(applyMigrations(db, [{ name: "../evil", sql: "select 1" }]), (e: unknown) => e instanceof InferloError && e.code === "IL4016");
  });
});

if (PG_URL) {
  // Own table names, because test files run in parallel against the same database.
  describe("applyMigrations (postgres)", () => {
    const MigUser = model("mig_users", { email: t.email().unique() });
    const MigTag = model("mig_tags", { label: t.string().max(30), userId: t.ref("mig_users") });
    const db = createDb([MigUser, MigTag], postgres({ url: PG_URL }));
    const reset = () => db.$sql('DROP TABLE IF EXISTS "mig_tags", "mig_users", "mig_docs", "mig_items", "mig_items_with_a_rather_long_table_name_here", "half_done", "inferlo_migrations" CASCADE');
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
      const rows = await db.$sql('SELECT name FROM "inferlo_migrations" ORDER BY name');
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

    test("a kairo_migrations table from Kairo 0.2 is renamed, gets a checksum column, filled on the next run", async () => {
      await db.$sql('DROP TABLE IF EXISTS "inferlo_migrations", "kairo_migrations"');
      await db.$sql('CREATE TABLE "kairo_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())');
      await db.$sql(`INSERT INTO "kairo_migrations" ("name") VALUES ('0020_old')`);
      const calls: string[][] = [];
      const onEdited = (names: string[]) => calls.push(names);
      assert.deepEqual(await applyMigrations(db, [{ name: "0020_old", sql: "SELECT 1;" }], { onEdited }), []);
      assert.deepEqual(calls, []);
      const rows = await db.$sql(`SELECT "checksum" FROM "inferlo_migrations" WHERE "name" = '0020_old'`);
      assert.match(String(rows[0]?.checksum), /^[0-9a-f]{64}$/);
      await applyMigrations(db, [{ name: "0020_old", sql: "SELECT 2;" }], { onEdited });
      assert.deepEqual(calls, [["0020_old"]]);
      assert.equal((await db.$sql(`SELECT to_regclass('"kairo_migrations"') AS t`))[0]?.t, null);
    });

    test("an allowChange migration changes defaults and required, and NULL rows block SET NOT NULL (IL4020)", async () => {
      const Doc = model("mig_docs", { title: t.string().max(50).optional(), state: t.string().max(10).default("draft"), score: t.int().optional() });
      const first = planMigration([Doc]);
      await applyMigrations(db, [{ name: "0030_docs", sql: first.statements.join(";\n\n") + ";\n" }]);
      await db.$sql(`INSERT INTO "mig_docs" ("id", "title") VALUES ('${crypto.randomUUID()}', NULL)`);

      const Doc2 = model("mig_docs", { title: t.string().max(50), state: t.string().max(10).nullable().default("draft"), score: t.int().default(5) });
      const plan = planMigration([Doc2], first.snapshot, { allowChange: true });
      const blocked = [{ name: "0031_required", sql: plan.statements.join(";\n\n") + ";\n" }];
      await assert.rejects(applyMigrations(db, blocked), (e: unknown) => {
        if (!(e instanceof InferloError) || e.code !== "IL4020") return false;
        assert.deepEqual(e.details, { migration: "0031_required", table: "mig_docs", column: "title" });
        assert.match(e.message, /mig_docs\.title/);
        assert.match(e.fix ?? "", /UPDATE "mig_docs" SET "title" = .* WHERE "title" IS NULL/);
        return true;
      });
      const recorded = await db.$sql(`SELECT 1 FROM "inferlo_migrations" WHERE "name" = '0031_required'`);
      assert.equal(recorded.length, 0);

      await db.$sql(`UPDATE "mig_docs" SET "title" = 'x' WHERE "title" IS NULL`);
      assert.deepEqual(await applyMigrations(db, blocked), ["0031_required"]);
      const rows = await db.$sql(`SELECT "title", "state", "score" FROM "mig_docs"`);
      assert.deepEqual(rows, [{ title: "x", state: "draft", score: 5 }]);
      const columns = await db.$sql(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'mig_docs' AND column_name IN ('title', 'state', 'score') ORDER BY column_name`,
      );
      assert.deepEqual(columns, [
        { column_name: "score", is_nullable: "NO", column_default: "5" },
        { column_name: "state", is_nullable: "YES", column_default: "'draft'::character varying" },
        { column_name: "title", is_nullable: "NO", column_default: null },
      ]);
    });

    test("an allowChange migration replaces enum values, and rows with a removed value block it (IL4021)", async () => {
      const Item = model("mig_items", { state: t.enum(["open", "done"]).default("open"), label: t.text().optional() });
      const first = planMigration([Item]);
      await applyMigrations(db, [{ name: "0040_items", sql: first.statements.join(";\n\n") + ";\n" }]);
      await db.$sql(`INSERT INTO "mig_items" ("id", "state") VALUES ('${crypto.randomUUID()}', 'done')`);

      const Item2 = model("mig_items", { state: t.enum(["open", "closed"]).default("open"), label: t.enum(["red", "blue"]).optional() });
      const plan = planMigration([Item2], first.snapshot, { allowChange: true });
      const blocked = [{ name: "0041_states", sql: plan.statements.join(";\n\n") + ";\n" }];
      await assert.rejects(applyMigrations(db, blocked), (e: unknown) => {
        if (!(e instanceof InferloError) || e.code !== "IL4021") return false;
        assert.deepEqual(e.details, { migration: "0041_states", table: "mig_items", constraint: "mig_items_state_check" });
        assert.match(e.message, /mig_items/);
        assert.match(e.fix ?? "", /UPDATE/);
        return true;
      });
      assert.equal((await db.$sql(`SELECT 1 FROM "inferlo_migrations" WHERE "name" = '0041_states'`)).length, 0);

      // The fix from IL4021: update the rows in the (not yet applied) file, before ADD CONSTRAINT.
      const add = plan.statements.findIndex((s) => s.includes("ADD CONSTRAINT"));
      const statements = [...plan.statements.slice(0, add), `UPDATE "mig_items" SET "state" = 'closed' WHERE "state" = 'done'`, ...plan.statements.slice(add)];
      assert.deepEqual(await applyMigrations(db, [{ name: "0041_states", sql: statements.join(";\n\n") + ";\n" }]), ["0041_states"]);
      assert.deepEqual(await db.$sql(`SELECT "state" FROM "mig_items"`), [{ state: "closed" }]);
      await db.$sql(`INSERT INTO "mig_items" ("id", "state", "label") VALUES ('${crypto.randomUUID()}', 'closed', 'red')`);
      await assert.rejects(db.$sql(`INSERT INTO "mig_items" ("id", "state") VALUES ('${crypto.randomUUID()}', 'done')`), /check constraint/);
      await assert.rejects(db.$sql(`INSERT INTO "mig_items" ("id", "label") VALUES ('${crypto.randomUUID()}', 'green')`), /check constraint/);

      // A second change finds the constraint the first one added.
      const Item3 = model("mig_items", { state: t.enum(["open", "closed", "done"]).default("open"), label: t.text().optional() });
      const third = planMigration([Item3], plan.snapshot, { allowChange: true });
      assert.deepEqual(await applyMigrations(db, [{ name: "0042_states", sql: third.statements.join(";\n\n") + ";\n" }]), ["0042_states"]);
      await db.$sql(`INSERT INTO "mig_items" ("id", "state", "label") VALUES ('${crypto.randomUUID()}', 'done', 'green')`);
    });

    test("the generated CHECK constraint name matches Postgres for long table and column names", async () => {
      const table = "mig_items_with_a_rather_long_table_name_here";
      const Long = model(table, { theStatusOfThisParticularRowInTheTable: t.enum(["x", "y"]) });
      const first = planMigration([Long]);
      await applyMigrations(db, [{ name: "0050_long", sql: first.statements.join(";\n\n") + ";\n" }]);
      const Long2 = model(table, { theStatusOfThisParticularRowInTheTable: t.enum(["x", "y", "z"]) });
      const plan = planMigration([Long2], first.snapshot, { allowChange: true });
      const [{ conname }] = (await db.$sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`)) as [{ conname: string }];
      assert.equal(plan.statements[0], `ALTER TABLE "${table}" DROP CONSTRAINT "${conname}"`);
      assert.deepEqual(await applyMigrations(db, [{ name: "0051_long", sql: plan.statements.join(";\n\n") + ";\n" }]), ["0051_long"]);
    });

    test("a failing migration is rolled back and not recorded", async () => {
      const files = [{ name: "0003_broken", sql: 'CREATE TABLE "half_done" ("x" int);\nSELECT * FROM "does_not_exist";' }];
      await assert.rejects(applyMigrations(db, files));
      const rows = await db.$sql(`SELECT name FROM "inferlo_migrations" WHERE name = '0003_broken'`);
      assert.equal(rows.length, 0);
      const tables = await db.$sql(`SELECT 1 FROM information_schema.tables WHERE table_name = 'half_done'`);
      assert.equal(tables.length, 0);
    });
  });
}

if (PG_URL) {
  describe("inferlo db migrate --apply (CLI, postgres)", () => {
    let dir = "";
    const pgDb = createDb([], postgres({ url: PG_URL }));
    const reset = () => pgDb.$sql('DROP TABLE IF EXISTS "cli_mig_notes", "inferlo_migrations" CASCADE');
    before(async () => {
      await reset();
      dir = mkdtempSync(path.join(os.tmpdir(), "inferlo-migrate-pg-"));
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

    test("lists edited files in edited and warns with IL4018", () => {
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
      assert.match(r3.stderr, /IL4018/);
      assert.match(r3.stderr, /migrations\/0001_init\.sql/);
      assert.match(r3.stdout, /No pending migrations/);
    });
  });
}

describe("inferlo db migrate (CLI)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "inferlo-migrate-"));
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
    assert.equal(r.out.error.code, "IL4013");
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 3);
  });

  test("drops need --allow-drop (IL4017), then are written and listed", () => {
    writeModels(["done: t.boolean().default(false)"]);
    const refused = cli("db", "migrate", "drop title");
    assert.equal(refused.status, 1);
    assert.equal(refused.out.error.code, "IL4017");
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

  test("default and required changes need --allow-change (IL4019), then are written and listed", () => {
    writeModels(["done: t.boolean()"]);
    const refused = cli("db", "migrate", "no default");
    assert.equal(refused.status, 1);
    assert.equal(refused.out.error.code, "IL4019");
    assert.equal(readdirSync(path.join(dir, "migrations")).length, 4);

    const r = cli("db", "migrate", "no default", "--allow-change");
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.equal(r.out.file, "migrations/0004_no_default.sql");
    assert.deepEqual(r.out.changes, ["change column notes.done (default false -> none)"]);
    assert.deepEqual(r.out.drops, []);
    const sql = readFileSync(path.join(dir, "migrations", "0004_no_default.sql"), "utf8");
    assert.match(sql, /ALTER TABLE "notes" ALTER COLUMN "done" DROP DEFAULT/);
    assert.match(sql, /-- This migration changes columns: change column notes\.done \(default false -> none\)/);
    assert.deepEqual(cli("db", "migrate").out.statements, []);
    writeModels(["done: t.boolean().default(false)"]);
    const back = cli("db", "migrate", "default again", "--allow-change");
    assert.equal(back.status, 0, JSON.stringify(back.out));
    assert.deepEqual(back.out.statements, ['ALTER TABLE "notes" ALTER COLUMN "done" SET DEFAULT false']);
  });

  test("an inferlo: 1 snapshot from 0.2.0 keeps working and is saved as inferlo: 2 with the next migration", () => {
    const snapshotFile = path.join(dir, "migrations", "snapshot.json");
    writeFileSync(snapshotFile, JSON.stringify(v1Snapshot([model("notes", { done: t.boolean().default(false) })]), null, 2) + "\n");
    const unchanged = cli("db", "migrate");
    assert.equal(unchanged.status, 0, JSON.stringify(unchanged.out));
    assert.deepEqual(unchanged.out.statements, []);
    assert.equal(JSON.parse(readFileSync(snapshotFile, "utf8")).inferlo, 1);

    writeModels(["done: t.boolean().default(false)", "pinned: t.boolean().default(false)"]);
    const r = cli("db", "migrate", "add pinned");
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.deepEqual(r.out.statements, ['ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL']);
    const saved = JSON.parse(readFileSync(snapshotFile, "utf8"));
    assert.equal(saved.inferlo, 2);
    assert.deepEqual(saved.tables.notes.columns.pinned, { type: "boolean", notNull: true, default: "false" });
    assert.deepEqual(cli("db", "migrate").out.statements, []);
  });

  test("--apply on memory() explains that Postgres is needed", () => {
    const r = cli("db", "migrate", "--apply");
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, "IL4008");
  });
});
