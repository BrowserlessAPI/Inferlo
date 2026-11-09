import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createDb, InferloError, model, planMigration, t } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

// Renames in inferlo db migrate: only generated when named (--rename / { renames }), so a rename is never a drop plus an add.

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const User = model("ren_users", { email: t.email().unique() });
const Note = model("ren_notes", {
  title: t.string().max(200),
  color: t.enum(["red", "blue"]).default("red"),
  dueAt: t.date().optional().index(),
  ownerId: t.ref("ren_users", { onDelete: "cascade" }),
});
const Tag = model("ren_tags", { label: t.string().max(30), noteId: t.ref("ren_notes") });

const isCode = (code: string, check?: (e: InferloError) => void) => (e: unknown) => {
  if (!(e instanceof InferloError) || e.code !== code) return false;
  check?.(e);
  return true;
};

describe("planMigration renames", () => {
  test("a renamed column without a rename is a drop (IL4017), and the fix names the --rename to use", () => {
    const first = planMigration([User, Note, Tag]);
    const { color, ...rest } = Note.fields;
    const Note2 = model("ren_notes", { ...rest, colour: color });
    assert.throws(
      () => planMigration([User, Note2, Tag], first.snapshot),
      isCode("IL4017", (e) => assert.match(e.fix ?? "", /--rename ren_notes\.color=ren_notes\.colour/)),
    );
  });

  test("a column rename keeps the data and renames its CHECK constraint and index", () => {
    const first = planMigration([User, Note, Tag]);
    const { color, dueAt, ...rest } = Note.fields;
    const Note2 = model("ren_notes", { ...rest, colour: color, deadlineAt: dueAt });
    const plan = planMigration([User, Note2, Tag], first.snapshot, { renames: { "ren_notes.color": "ren_notes.colour", "ren_notes.dueAt": "ren_notes.deadlineAt" } });
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "ren_notes" RENAME COLUMN "color" TO "colour"',
      'ALTER TABLE "ren_notes" RENAME COLUMN "due_at" TO "deadline_at"',
      'ALTER TABLE "ren_notes" RENAME CONSTRAINT "ren_notes_color_check" TO "ren_notes_colour_check"',
      'ALTER INDEX "ren_notes_due_at_idx" RENAME TO "ren_notes_deadline_at_idx"',
    ]);
    assert.deepEqual(plan.renames, ["rename column ren_notes.color -> ren_notes.colour", "rename column ren_notes.due_at -> ren_notes.deadline_at"]);
    assert.deepEqual(plan.drops, []);
    assert.deepEqual(planMigration([User, Note2, Tag], plan.snapshot).statements, []);
  });

  test("a table rename renames its foreign keys and indexes, and references to it follow", () => {
    const first = planMigration([User, Note, Tag]);
    const Memo = model("ren_memos", Note.fields);
    const Tag2 = model("ren_tags", { label: t.string().max(30), noteId: t.ref("ren_memos") });
    assert.throws(() => planMigration([User, Memo, Tag2], first.snapshot), isCode("IL4017", (e) => assert.match(e.fix ?? "", /--rename ren_notes=ren_memos/)));
    const plan = planMigration([User, Memo, Tag2], first.snapshot, { renames: { ren_notes: "ren_memos" } });
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "ren_notes" RENAME TO "ren_memos"',
      'ALTER TABLE "ren_memos" RENAME CONSTRAINT "ren_notes_color_check" TO "ren_memos_color_check"',
      'ALTER INDEX "ren_notes_due_at_idx" RENAME TO "ren_memos_due_at_idx"',
      'ALTER TABLE "ren_memos" RENAME CONSTRAINT "ren_notes_owner_id_fkey" TO "ren_memos_owner_id_fkey"',
      'ALTER INDEX "ren_notes_owner_id_idx" RENAME TO "ren_memos_owner_id_idx"',
    ]);
    assert.deepEqual(plan.renames, ["rename table ren_notes -> ren_memos"]);
    assert.deepEqual(planMigration([User, Memo, Tag2], plan.snapshot).statements, []);
  });

  test("a table and one of its columns renamed together, with a type change of that column", () => {
    const first = planMigration([User, Note, Tag]);
    const { title, ...rest } = Note.fields;
    const Memo = model("ren_memos", { ...rest, heading: t.string().max(300) });
    const Tag2 = model("ren_tags", { label: t.string().max(30), noteId: t.ref("ren_memos") });
    const renames = { ren_notes: "ren_memos", "ren_notes.title": "ren_memos.heading" };
    assert.throws(() => planMigration([User, Memo, Tag2], first.snapshot, { renames }), isCode("IL4019"));
    const plan = planMigration([User, Memo, Tag2], first.snapshot, { renames, allowChange: true });
    assert.deepEqual(plan.statements.slice(0, 2), ['ALTER TABLE "ren_notes" RENAME TO "ren_memos"', 'ALTER TABLE "ren_memos" RENAME COLUMN "title" TO "heading"']);
    assert.ok(plan.statements.includes('ALTER TABLE "ren_memos" ALTER COLUMN "heading" TYPE varchar(300)'));
    assert.deepEqual(plan.changes, ["change column ren_memos.heading (type varchar(200) -> varchar(300))"]);
    assert.deepEqual(planMigration([User, Memo, Tag2], plan.snapshot).statements, []);
  });

  test("invalid renames raise IL4032", () => {
    const first = planMigration([User, Note, Tag]);
    const { color, ...rest } = Note.fields;
    const Note2 = model("ren_notes", { ...rest, colour: color });
    const invalid: Record<string, string>[] = [
      { "ren_notes.color": "ren_notes" },
      { "ren_notes.color": "ren_tags.colour" },
      { "ren_notes.shade": "ren_notes.colour" },
      { "ren_notes.color": "ren_notes.hue" },
      { "ren_notes.title": "ren_notes.colour" },
      { "ren_missing.color": "ren_missing.colour" },
      { ren_notes: "ren_tags" },
      { "ren_notes.color": 'ren_notes.x"; DROP TABLE x; --' },
      { "a.b.c": "a.b.d" },
    ];
    for (const renames of invalid) {
      assert.throws(() => planMigration([User, Note2, Tag], first.snapshot, { renames }), isCode("IL4032", (e) => assert.match(e.fix ?? "", /--rename/)), JSON.stringify(renames));
    }
    assert.throws(() => planMigration([User, Note, Tag], first.snapshot, { renames: { ren_notes: "ren_memos" } }), isCode("IL4032"));
  });
});

describe("inferlo db migrate --rename (CLI)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "inferlo-rename-"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const writeModel = (table: string, fields: string) => {
    const index = JSON.stringify(path.join(repo, "src", "index.ts"));
    writeFileSync(
      path.join(dir, "src", "app.ts"),
      `import { createApp, memory, model, t } from ${index};\nexport const Note = model(${JSON.stringify(table)}, { ${fields} });\nexport const app = createApp({ models: [Note], routes: [], db: memory(), logger: { info() {}, error() {} } });\n`,
    );
  };
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(repo, "src", "cli", "main.ts"), ...args, "--json"], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") };
  };

  test("--rename can be given several times, as --rename a=b or --rename=a=b", () => {
    writeModel("notes", 'title: t.string().max(100), color: t.string().max(20).index()');
    assert.equal(cli("db", "migrate", "init").status, 0);
    writeModel("memos", 'heading: t.string().max(100), colour: t.string().max(20).index()');
    const refused = cli("db", "migrate", "rename");
    assert.equal(refused.status, 1);
    assert.equal(refused.out.error.code, "IL4017");
    const r = cli("db", "migrate", "rename", "--rename", "notes=memos", "--rename=notes.title=memos.heading", "--rename", "notes.color=memos.colour");
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.equal(r.out.file, "migrations/0002_rename.sql");
    assert.deepEqual(r.out.renames, ["rename table notes -> memos", "rename column notes.title -> memos.heading", "rename column notes.color -> memos.colour"]);
    const file = readFileSync(path.join(dir, r.out.file), "utf8");
    assert.match(file, /-- This migration renames: rename table notes -> memos/);
    assert.match(file, /ALTER TABLE "notes" RENAME TO "memos";/);
    assert.match(file, /ALTER INDEX "notes_color_idx" RENAME TO "memos_colour_idx";/);
    assert.deepEqual(cli("db", "migrate").out.statements, []);
    const bad = cli("db", "migrate", "--rename", "memos.colour");
    assert.equal(bad.status, 1);
    assert.equal(bad.out.error.code, "IL4032");
  });
});

if (PG_URL) {
  describe("renames (postgres)", () => {
    const db = createDb([User], postgres({ url: PG_URL }));
    // The files run with db.$sql, not applyMigrations: test/migrate.test.ts resets "inferlo_migrations" while other files run.
    const reset = () => db.$sql('DROP TABLE IF EXISTS "ren_tags", "ren_notes", "ren_memos", "ren_users" CASCADE');
    const apply = (sql: string) => db.$transaction((tx) => tx.$sql(sql));
    before(reset);
    after(async () => {
      await reset();
      await db.$close();
    });

    test("renamed tables and columns keep their rows, and later changes find the renamed constraints", async () => {
      const first = planMigration([User, Note, Tag]);
      const sql = (statements: string[]) => statements.join(";\n\n") + ";\n";
      await apply(sql(first.statements));
      const user = crypto.randomUUID();
      const note = crypto.randomUUID();
      await db.$sql(`INSERT INTO "ren_users" ("id", "email") VALUES ('${user}', 'r@example.com')`);
      await db.$sql(`INSERT INTO "ren_notes" ("id", "title", "color", "owner_id") VALUES ('${note}', 'Keep me', 'blue', '${user}')`);
      await db.$sql(`INSERT INTO "ren_tags" ("id", "label", "note_id") VALUES ('${crypto.randomUUID()}', 'x', '${note}')`);

      const { title, color, ...rest } = Note.fields;
      const Memo = model("ren_memos", { ...rest, heading: title, colour: color });
      const Tag2 = model("ren_tags", { label: t.string().max(30), noteId: t.ref("ren_memos") });
      const plan = planMigration([User, Memo, Tag2], first.snapshot, { renames: { ren_notes: "ren_memos", "ren_notes.title": "ren_memos.heading", "ren_notes.color": "ren_memos.colour" } });
      await apply(sql(plan.statements));
      assert.deepEqual(await db.$sql(`SELECT "heading", "colour" FROM "ren_memos"`), [{ heading: "Keep me", colour: "blue" }]);
      const constraints = (await db.$sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"ren_memos"'::regclass AND contype IN ('c', 'f') ORDER BY conname`)).map((r) => r.conname);
      assert.deepEqual(constraints, ["ren_memos_colour_check", "ren_memos_owner_id_fkey"]);
      const indexes = (await db.$sql(`SELECT indexname FROM pg_indexes WHERE tablename = 'ren_memos' AND indexname <> 'ren_notes_pkey' ORDER BY indexname`)).map((r) => r.indexname);
      assert.deepEqual(indexes, ["ren_memos_due_at_idx", "ren_memos_owner_id_idx"]);
      // The tag's foreign key follows the renamed table.
      await assert.rejects(db.$sql(`INSERT INTO "ren_tags" ("id", "label", "note_id") VALUES ('${crypto.randomUUID()}', 'y', '${crypto.randomUUID()}')`), isCode("IL4011"));

      // Later changes use the new names: an enum value and an onDelete change.
      const Memo2 = model("ren_memos", { ...rest, heading: title, colour: t.enum(["red", "blue", "green"]).default("red"), ownerId: t.ref("ren_users") });
      const next = planMigration([User, Memo2, Tag2], plan.snapshot, { allowChange: true });
      await apply(sql(next.statements));
      await db.$sql(`UPDATE "ren_memos" SET "colour" = 'green'`);
      await assert.rejects(db.$sql(`DELETE FROM "ren_users" WHERE "id" = '${user}'`), isCode("IL4011"));
    });
  });
}
