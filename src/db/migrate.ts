/**
 * Versioned SQL migrations (PostgreSQL).
 *
 *   kairo db migrate add_due_dates   # writes migrations/0002_add_due_dates.sql
 *   kairo db migrate --apply         # runs pending files, recorded in "kairo_migrations"
 *
 * planMigration compares your models with migrations/snapshot.json (the models as of the last
 * generated migration) and returns the SQL for the difference. Additive changes are generated
 * directly. Drops of tables, columns and indexes delete data, so they are refused with KR4017
 * unless you pass { allowDrop: true } (kairo db migrate --allow-drop). Renames and column
 * changes are refused with KR4013, so nothing is lost silently. Snapshots in the 0.2.0 format
 * (kairo: 1) are read and upgraded; plans always return the current format (kairo: 2).
 */
import { KairoError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnDefinition, columnType, createTableSql, defaultSql, modelIndexes, sortByReferences, SYSTEM_COLUMNS } from "./postgres.ts";
import type { DbRecord } from "./types.ts";

/** One column in migrations/snapshot.json. Compared field by field to find column changes. */
export interface MigrationSnapshotColumn {
  /** Postgres type, e.g. "text", "varchar(80)", "integer", "jsonb". */
  type: string;
  /** NOT NULL (required fields). */
  notNull: boolean;
  /** SQL DEFAULT expression, e.g. "0", "'open'", "now()". Absent when there is no fixed default. */
  default?: string;
  /** Allowed values of a t.enum field (CHECK constraint). */
  enum?: string[];
  /** Foreign key of a t.ref field. */
  references?: { table: string; onDelete: "restrict" | "cascade" | "set null" };
  /** Only the "id" column. */
  primaryKey?: true;
}

/** The models as of the last generated migration. Stored as migrations/snapshot.json. */
export interface MigrationSnapshot {
  kairo: 2;
  tables: Record<string, { columns: Record<string, MigrationSnapshotColumn>; indexes: Record<string, string> }>;
}

/** The snapshot format written by Kairo 0.2.0 (each column as its SQL definition). planMigration upgrades it. */
export interface MigrationSnapshotV1 {
  kairo: 1;
  tables: Record<string, { columns: Record<string, string>; indexes: Record<string, string> }>;
}

export interface MigrationPlan {
  /** SQL statements to put in the new migration file, in order. Empty when nothing changed. */
  statements: string[];
  /** Snapshot to save after writing the file. */
  snapshot: MigrationSnapshot;
  /** The drops included in `statements`, e.g. "drop column tasks.notes". Empty unless allowDrop was set. */
  drops: string[];
}

export interface PlanMigrationOptions {
  /** Generate DROP statements for removed tables, columns and indexes. These delete data. Default false. */
  allowDrop?: boolean;
}

export interface Migration {
  /** File name without .sql, e.g. "0001_init". Sorted by name to decide the order. */
  name: string;
  sql: string;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function columnSnapshot(schema: AnySchema): MigrationSnapshotColumn {
  const d = schema.def;
  const column: MigrationSnapshotColumn = { type: columnType(schema), notNull: !d.optional && !d.nullable && d.kind !== "any" };
  const fixedDefault = defaultSql(schema);
  if (fixedDefault !== undefined) column.default = fixedDefault;
  if (d.kind === "enum" && d.values) column.enum = d.values.map(String);
  if (d.kind === "ref" && d.refTable) column.references = { table: d.refTable, onDelete: d.onDelete ?? "restrict" };
  return column;
}

function tableSnapshot(model: AnyModel): MigrationSnapshot["tables"][string] {
  const columns: Record<string, MigrationSnapshotColumn> = Object.fromEntries(SYSTEM_COLUMNS.map(([column, sql]) => [column, parseColumnSql(sql)!]));
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) columns[columnName(field)] = columnSnapshot(schema);
  return { columns, indexes: Object.fromEntries(modelIndexes(model)) };
}

const IDENT = `"(?:[^"]|"")*"`;
const STRING = `'(?:[^']|'')*'`;
const unquote = (s: string) => s.slice(1, -1).replace(/''/g, "'");

/**
 * Parse a column definition as written by Kairo 0.2.0 (columnDefinition) into its structured form.
 * Returns undefined for anything else.
 */
function parseColumnSql(sql: string): MigrationSnapshotColumn | undefined {
  const head = new RegExp(`^${IDENT} (double precision|varchar\\(\\d+\\)|[a-z]+)`).exec(sql);
  if (!head) return undefined;
  const column: MigrationSnapshotColumn = { type: head[1]!, notNull: false };
  let rest = sql.slice(head[0].length);
  const clauses: [RegExp, (m: RegExpExecArray) => void][] = [
    [/^ PRIMARY KEY/, () => ((column.primaryKey = true), (column.notNull = true))],
    [/^ NOT NULL/, () => (column.notNull = true)],
    [new RegExp(`^ DEFAULT (${STRING}(?:::jsonb)?|now\\(\\)|true|false|-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`), (m) => (column.default = m[1])],
    [
      new RegExp(`^ CHECK \\(${IDENT} IN \\((${STRING}(?:, ${STRING})*)\\)\\)`),
      (m) => (column.enum = (m[1]!.match(new RegExp(STRING, "g")) ?? []).map(unquote)),
    ],
    [
      new RegExp(`^ REFERENCES (${IDENT})\\("id"\\) ON DELETE (RESTRICT|CASCADE|SET NULL)`),
      (m) => (column.references = { table: m[1]!.slice(1, -1).replace(/""/g, '"'), onDelete: m[2]!.toLowerCase() as "restrict" | "cascade" | "set null" }),
    ],
  ];
  while (rest) {
    const clause = clauses.map(([re, apply]) => [re.exec(rest), apply] as const).find(([m]) => m);
    if (!clause) return undefined;
    clause[1](clause[0]!);
    rest = rest.slice(clause[0]![0].length);
  }
  // Keep the same key order as columnSnapshot, so upgraded snapshots look like fresh ones.
  const { type, notNull, default: fixedDefault, enum: values, references, primaryKey } = column;
  return {
    type,
    notNull,
    ...(fixedDefault !== undefined && { default: fixedDefault }),
    ...(values && { enum: values }),
    ...(references && { references }),
    ...(primaryKey && { primaryKey }),
  };
}

function needsValue(schema: AnySchema): boolean {
  const d = schema.def;
  return !d.optional && !d.nullable && d.kind !== "any" && !(d.hasDefault && typeof d.defaultValue !== "function");
}

function invalidSnapshot(fix = "migrations/snapshot.json must be the file written by kairo db migrate. Restore it from version control; do not edit it by hand."): never {
  throw new KairoError("KR4015", "The migration snapshot is not valid.", { fix, expose: true });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isColumn(c: unknown): c is MigrationSnapshotColumn {
  return (
    isRecord(c) &&
    typeof c.type === "string" &&
    typeof c.notNull === "boolean" &&
    (c.default === undefined || typeof c.default === "string") &&
    (c.enum === undefined || (Array.isArray(c.enum) && c.enum.every((v) => typeof v === "string"))) &&
    (c.references === undefined || (isRecord(c.references) && typeof c.references.table === "string" && typeof c.references.onDelete === "string"))
  );
}

/** Validate a snapshot and return it in the current (kairo: 2) format. */
function readSnapshot(previous: unknown): MigrationSnapshot {
  if (!isRecord(previous) || (previous.kairo !== 1 && previous.kairo !== 2) || !isRecord(previous.tables)) invalidSnapshot();
  const tables: MigrationSnapshot["tables"] = {};
  for (const [name, table] of Object.entries(previous.tables)) {
    if (!isRecord(table) || !isRecord(table.columns) || !isRecord(table.indexes)) invalidSnapshot();
    const columns: Record<string, MigrationSnapshotColumn> = {};
    for (const [column, value] of Object.entries(table.columns)) {
      const parsed = previous.kairo === 1 ? (typeof value === "string" ? parseColumnSql(value) : undefined) : isColumn(value) ? value : undefined;
      if (!parsed) {
        invalidSnapshot(
          `Column ${name}.${column} in migrations/snapshot.json is not in the format kairo db migrate writes. Restore the file from version control; do not edit it by hand.`,
        );
      }
      columns[column] = parsed;
    }
    tables[name] = { columns, indexes: table.indexes as Record<string, string> };
  }
  return { kairo: 2, tables };
}

/** Plain descriptions of what differs between two versions of a column, e.g. "type text -> varchar(80)". */
function columnChanges(before: MigrationSnapshotColumn, now: MigrationSnapshotColumn): string[] {
  const out: string[] = [];
  const ref = (r: MigrationSnapshotColumn["references"]) => (r ? `${r.table} on delete ${r.onDelete}` : "none");
  const values = (v: string[] | undefined) => (v ? v.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ") : "none");
  if (before.type !== now.type) out.push(`type ${before.type} -> ${now.type}`);
  if (before.notNull !== now.notNull) out.push(before.notNull ? "required -> optional" : "optional -> required");
  if (before.default !== now.default) out.push(`default ${before.default ?? "none"} -> ${now.default ?? "none"}`);
  if (values(before.enum) !== values(now.enum)) out.push(`enum values ${values(before.enum)} -> ${values(now.enum)}`);
  if (ref(before.references) !== ref(now.references)) out.push(`reference ${ref(before.references)} -> ${ref(now.references)}`);
  if (Boolean(before.primaryKey) !== Boolean(now.primaryKey)) out.push(before.primaryKey ? "primary key -> none" : "none -> primary key");
  return out;
}

/** SQL to bring the database from `previous` (or an empty database) to `models`. */
export function planMigration(
  models: readonly AnyModel[],
  previous?: MigrationSnapshot | MigrationSnapshotV1,
  options: PlanMigrationOptions = {},
): MigrationPlan {
  const before = previous === undefined ? {} : readSnapshot(previous).tables;
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { kairo: 2, tables: {} };
  const statements: string[] = [];
  const refused: string[] = [];
  const changedColumns: { table: string; column: string; changes: string[] }[] = [];
  const drops: string[] = [];
  const needDefault: string[] = [];

  for (const model of sorted) {
    const now = tableSnapshot(model);
    snapshot.tables[model.name] = now;
    const old = before[model.name];
    if (!old) {
      statements.push(...createTableSql(model));
      continue;
    }
    const dropIndexes: string[] = [];
    const dropColumns: string[] = [];
    for (const [column, description] of Object.entries(old.columns)) {
      if (!(column in now.columns)) {
        drops.push(`drop column ${model.name}.${column}`);
        dropColumns.push(`ALTER TABLE ${q(model.name)} DROP COLUMN IF EXISTS ${q(column)}`);
        continue;
      }
      const changes = columnChanges(description, now.columns[column]!);
      if (changes.length) {
        refused.push(`change column ${model.name}.${column}`);
        changedColumns.push({ table: model.name, column, changes });
      }
    }
    for (const [name, sql] of Object.entries(old.indexes)) {
      if (!(name in now.indexes)) {
        drops.push(`drop index ${name}`);
        dropIndexes.push(`DROP INDEX IF EXISTS ${q(name)}`);
      } else if (now.indexes[name] !== sql) refused.push(`change index ${name}`);
    }
    statements.push(...dropIndexes, ...dropColumns);
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      const column = columnName(field);
      if (column in old.columns) continue;
      if (needsValue(schema)) needDefault.push(`${model.name}.${column}`);
      statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN IF NOT EXISTS ${columnDefinition(model, field, schema)}`);
    }
    for (const [name, sql] of Object.entries(now.indexes)) if (!(name in old.indexes)) statements.push(sql);
  }
  const droppedTables = Object.keys(before).filter((table) => !(table in snapshot.tables));
  if (droppedTables.length) {
    drops.push(...droppedTables.map((table) => `drop table ${table}`));
    // One statement, so foreign keys between the dropped tables do not matter. No CASCADE:
    // if anything else still depends on a table, the migration fails instead of dropping more.
    statements.push(`DROP TABLE IF EXISTS ${droppedTables.map(q).join(", ")}`);
  }

  if (refused.length) {
    const explained = refused.map((change) => {
      const column = changedColumns.find((c) => change === `change column ${c.table}.${c.column}`);
      return column ? `${change} (${column.changes.join(", ")})` : change;
    });
    throw new KairoError("KR4013", `kairo db migrate cannot generate these changes yet: ${explained.join(", ")}.`, {
      fix: "New tables, columns and indexes, and drops with --allow-drop, are generated. Renames and column changes are not yet: undo these model changes, or write the SQL yourself in a new migration file.",
      details: { changes: refused, columns: changedColumns },
      expose: true,
    });
  }
  if (drops.length && !options.allowDrop) {
    throw new KairoError("KR4017", `Your model changes drop data: ${drops.join(", ")}.`, {
      fix: "If you mean to delete this data, run kairo db migrate --allow-drop (or planMigration(models, snapshot, { allowDrop: true })) and review the file. Otherwise restore the removed models, fields or indexes.",
      details: { drops },
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
  return { statements, snapshot, drops };
}

const MIGRATION_NAME = /^[A-Za-z0-9_-]{1,200}$/;
const LOCK_KEY = 4_812_330_227;

interface SqlDb {
  $sql(text: string, params?: unknown[]): Promise<DbRecord[]>;
  $transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}

export interface ApplyMigrationsOptions {
  /**
   * Called with the names of migrations that were already applied but whose SQL has changed since
   * (KR4018). They are not run again. Restore the applied SQL and put the change in a new file.
   */
  onEdited?: (names: string[]) => void;
}

/** SHA-256 of the SQL as hex, with Windows line endings normalised so a checkout does not count as an edit. */
async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql.replace(/\r\n/g, "\n")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Run the migrations that are not yet recorded in the "kairo_migrations" table, in name order,
 * each in its own transaction. Returns the names it applied. Safe to run from several processes
 * at once (a Postgres advisory lock serialises them).
 *
 * Each applied migration is recorded with a checksum of its SQL. Applied migrations whose SQL has
 * changed since are reported to options.onEdited (KR4018) and are not run again.
 */
export async function applyMigrations(db: SqlDb, migrations: readonly Migration[], options: ApplyMigrationsOptions = {}): Promise<string[]> {
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
  await db.$sql(`CREATE TABLE IF NOT EXISTS "kairo_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now(), "checksum" text)`);
  // Tables created by Kairo 0.2 have no checksum column. Checked first, because ALTER TABLE locks the table.
  const hasChecksum = await db.$sql(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kairo_migrations' AND column_name = 'checksum'`,
  );
  if (!hasChecksum.length) await db.$sql(`ALTER TABLE "kairo_migrations" ADD COLUMN IF NOT EXISTS "checksum" text`);
  const done = new Map((await db.$sql(`SELECT "name", "checksum" FROM "kairo_migrations"`)).map((r) => [String(r.name), r.checksum == null ? null : String(r.checksum)]));
  const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sums = new Map(await Promise.all(sorted.map(async (m) => [m.name, await checksum(m.sql)] as const)));
  const edited: string[] = [];
  for (const m of sorted) {
    if (!done.has(m.name)) continue;
    const recorded = done.get(m.name);
    // Applied before checksums were recorded: record the current file.
    if (recorded === null) await db.$sql(`UPDATE "kairo_migrations" SET "checksum" = $1 WHERE "name" = $2 AND "checksum" IS NULL`, [sums.get(m.name), m.name]);
    else if (recorded !== sums.get(m.name)) edited.push(m.name);
  }
  if (edited.length) options.onEdited?.(edited);
  const applied: string[] = [];
  for (const m of sorted) {
    if (done.has(m.name)) continue;
    const ran = await db.$transaction(async (tx) => {
      await tx.$sql(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      if ((await tx.$sql(`SELECT 1 FROM "kairo_migrations" WHERE "name" = $1`, [m.name])).length) return false;
      await tx.$sql(m.sql);
      await tx.$sql(`INSERT INTO "kairo_migrations" ("name", "checksum") VALUES ($1, $2)`, [m.name, sums.get(m.name)]);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}
