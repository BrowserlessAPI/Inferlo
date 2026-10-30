/**
 * Versioned SQL migrations (PostgreSQL).
 *
 *   kairo db migrate add_due_dates   # writes migrations/0002_add_due_dates.sql
 *   kairo db migrate --apply         # runs pending files, recorded in "kairo_migrations"
 *
 * planMigration compares your models with migrations/snapshot.json (the models as of the last
 * generated migration) and returns the SQL for the difference. It only generates additive
 * changes; drops, renames and column changes are refused with KR4013 so nothing is lost silently.
 */
import { KairoError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnDefinition, createTableSql, modelIndexes, sortByReferences, SYSTEM_COLUMNS } from "./postgres.ts";
import type { DbRecord } from "./types.ts";

/** The models as of the last generated migration. Stored as migrations/snapshot.json. */
export interface MigrationSnapshot {
  kairo: 1;
  tables: Record<string, { columns: Record<string, string>; indexes: Record<string, string> }>;
}

export interface MigrationPlan {
  /** SQL statements to put in the new migration file, in order. Empty when nothing changed. */
  statements: string[];
  /** Snapshot to save after writing the file. */
  snapshot: MigrationSnapshot;
}

export interface Migration {
  /** File name without .sql, e.g. "0001_init". Sorted by name to decide the order. */
  name: string;
  sql: string;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function tableSnapshot(model: AnyModel): MigrationSnapshot["tables"][string] {
  const columns: Record<string, string> = Object.fromEntries(SYSTEM_COLUMNS);
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) columns[columnName(field)] = columnDefinition(model, field, schema);
  return { columns, indexes: Object.fromEntries(modelIndexes(model)) };
}

function needsValue(schema: AnySchema): boolean {
  const d = schema.def;
  return !d.optional && !d.nullable && d.kind !== "any" && !(d.hasDefault && typeof d.defaultValue !== "function");
}

function checkSnapshot(previous: unknown): asserts previous is MigrationSnapshot {
  const p = previous as MigrationSnapshot | null;
  const ok =
    !!p &&
    typeof p === "object" &&
    p.kairo === 1 &&
    !!p.tables &&
    typeof p.tables === "object" &&
    Object.values(p.tables).every((t) => !!t && typeof t.columns === "object" && typeof t.indexes === "object");
  if (!ok) {
    throw new KairoError("KR4015", "The migration snapshot is not valid.", {
      fix: "migrations/snapshot.json must be the file written by kairo db migrate. Restore it from version control; do not edit it by hand.",
      expose: true,
    });
  }
}

/** SQL to bring the database from `previous` (or an empty database) to `models`. */
export function planMigration(models: readonly AnyModel[], previous?: MigrationSnapshot): MigrationPlan {
  if (previous !== undefined) checkSnapshot(previous);
  const before = previous?.tables ?? {};
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { kairo: 1, tables: {} };
  const statements: string[] = [];
  const refused: string[] = [];
  const needDefault: string[] = [];

  for (const model of sorted) {
    const now = tableSnapshot(model);
    snapshot.tables[model.name] = now;
    const old = before[model.name];
    if (!old) {
      statements.push(...createTableSql(model));
      continue;
    }
    const fields = Object.entries(model.fields as Record<string, AnySchema>);
    for (const [column, definition] of Object.entries(old.columns)) {
      if (!(column in now.columns)) refused.push(`drop column ${model.name}.${column}`);
      else if (now.columns[column] !== definition) refused.push(`change column ${model.name}.${column}`);
    }
    for (const [field, schema] of fields) {
      const column = columnName(field);
      if (column in old.columns) continue;
      if (needsValue(schema)) needDefault.push(`${model.name}.${column}`);
      statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN IF NOT EXISTS ${now.columns[column]}`);
    }
    for (const [name, sql] of Object.entries(old.indexes)) {
      if (!(name in now.indexes)) refused.push(`drop index ${name}`);
      else if (now.indexes[name] !== sql) refused.push(`change index ${name}`);
    }
    for (const [name, sql] of Object.entries(now.indexes)) if (!(name in old.indexes)) statements.push(sql);
  }
  for (const table of Object.keys(before)) if (!(table in snapshot.tables)) refused.push(`drop table ${table}`);

  if (refused.length) {
    throw new KairoError("KR4013", `kairo db migrate cannot generate these changes yet: ${refused.join(", ")}.`, {
      fix: "Only new tables, columns and indexes are generated for now. Undo these model changes, or write the SQL yourself in a new migration file.",
      details: { changes: refused },
      expose: true,
    });
  }
  if (needDefault.length) {
    throw new KairoError("KR4014", `New required column${needDefault.length > 1 ? "s" : ""} ${needDefault.join(", ")} on an existing table need a value for existing rows.`, {
      fix: 'Add .default(value) (a fixed value, not a function) or .optional() to the field, e.g. status: t.enum(["open", "closed"]).default("open").',
      details: { columns: needDefault },
      expose: true,
    });
  }
  return { statements, snapshot };
}

const MIGRATION_NAME = /^[A-Za-z0-9_-]{1,200}$/;
const LOCK_KEY = 4_812_330_227;

interface SqlDb {
  $sql(text: string, params?: unknown[]): Promise<DbRecord[]>;
  $transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}

/**
 * Run the migrations that are not yet recorded in the "kairo_migrations" table, in name order,
 * each in its own transaction. Returns the names it applied. Safe to run from several processes
 * at once (a Postgres advisory lock serialises them).
 */
export async function applyMigrations(db: SqlDb, migrations: readonly Migration[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!MIGRATION_NAME.test(m.name) || seen.has(m.name)) {
      throw new KairoError("KR4016", `Invalid or duplicate migration name "${m.name}".`, {
        fix: "Migration names use letters, digits, _ and -, and must be unique, e.g. 0002_add_due_dates.",
        expose: true,
      });
    }
    seen.add(m.name);
  }
  await db.$sql(`CREATE TABLE IF NOT EXISTS "kairo_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.$sql(`SELECT "name" FROM "kairo_migrations"`)).map((r) => String(r.name)));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (done.has(m.name)) continue;
    const ran = await db.$transaction(async (tx) => {
      await tx.$sql(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      if ((await tx.$sql(`SELECT 1 FROM "kairo_migrations" WHERE "name" = $1`, [m.name])).length) return false;
      await tx.$sql(m.sql);
      await tx.$sql(`INSERT INTO "kairo_migrations" ("name") VALUES ($1)`, [m.name]);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}
