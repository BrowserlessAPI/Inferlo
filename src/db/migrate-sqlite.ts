/**
 * Migration files for SQLite: planMigration(models, snapshot, { dialect: "sqlite" }) and applyMigrations() on a
 * sqlite() database.
 *
 * Generated: new tables, new columns (a required column needs a fixed default, IL4014), new indexes, with
 * { allowDrop: true } drops of tables, columns (their indexes first) and indexes (otherwise IL4017), and renames
 * named with { renames }: RENAME TO and RENAME COLUMN, which SQLite carries into CHECK and REFERENCES clauses, and
 * the indexes named after them created again under their new names (SQLite cannot rename an index). SQLite cannot
 * change a column in place, so with { allowChange: true } (otherwise IL4019) type (integer to number only, IL4013
 * for others), default, required/optional, enum value and reference changes rebuild the table (rebuildSql).
 *
 * SQLite runs schema changes in transactions, so each file is applied in one transaction (BEGIN IMMEDIATE, which
 * also keeps two processes apart) together with its record in inferlo_migrations: a failing statement rolls the
 * whole file back (IL4039). Foreign keys are not enforced while a file runs, so rebuilt tables can be dropped and
 * renamed; PRAGMA foreign_key_check runs before the file commits.
 */
import { InferloError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnChanges, isAlterable, renameHint, renameSnapshot, type Migration, type MigrationPlan, type MigrationSnapshot, type MigrationSnapshotColumn, type RenameDialect } from "./migrate.ts";
import { splitStatements } from "./migrate-mysql.ts";
import { columnDefinition, createTableSql, kindOf, literal, modelIndexes, sortByReferences, SQL_TYPE } from "./sqlite.ts";
import type { DbRecord } from "./types.ts";

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const SYSTEM_COLUMNS: Record<string, MigrationSnapshotColumn> = {
  id: { type: "TEXT", notNull: true, primaryKey: true },
  created_at: { type: "TEXT", notNull: true },
  updated_at: { type: "TEXT", notNull: true },
};

const fixedDefault = (schema: AnySchema) => (schema.def.hasDefault && typeof schema.def.defaultValue !== "function" ? literal(kindOf(schema), schema.def.defaultValue) : undefined);

function columnSnapshot(schema: AnySchema): MigrationSnapshotColumn {
  const d = schema.def;
  const column: MigrationSnapshotColumn = { type: SQL_TYPE[kindOf(schema)], notNull: !d.optional && !d.nullable && d.kind !== "any" };
  const value = fixedDefault(schema);
  if (value !== undefined) column.default = value;
  if (d.kind === "enum" && d.values) column.enum = d.values.map(String);
  if (d.kind === "ref" && d.refTable) column.references = { table: d.refTable, onDelete: d.onDelete ?? "restrict" };
  return column;
}

function tableSnapshot(model: AnyModel): MigrationSnapshot["tables"][string] {
  const columns: Record<string, MigrationSnapshotColumn> = { ...SYSTEM_COLUMNS };
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) columns[columnName(field)] = columnSnapshot(schema);
  return { columns, indexes: Object.fromEntries(modelIndexes(model)) };
}

/** Read a SQLite snapshot. Snapshots written for another database are refused (IL4037): their SQL and types differ. */
function readSqliteSnapshot(input: unknown): MigrationSnapshot["tables"] {
  if (input === undefined) return {};
  const s = input as { inferlo?: unknown; dialect?: unknown; tables?: unknown };
  if (!s || typeof s !== "object" || s.inferlo !== 2 || typeof s.tables !== "object" || s.tables === null) {
    throw new InferloError("IL4015", "migrations/snapshot.json is not a valid Inferlo snapshot.", {
      fix: "migrations/snapshot.json must be the file written by inferlo db migrate. Restore it from version control; do not edit it by hand.",
      expose: true,
    });
  }
  if (s.dialect !== "sqlite") {
    const other = s.dialect === "mysql" ? "MySQL" : "PostgreSQL";
    throw new InferloError("IL4037", `migrations/snapshot.json and the migration files were written for ${other}, and this app uses SQLite.`, {
      fix: `Migration files are written for one database. Keep the ${other} migrations folder with the ${other} app; for SQLite, move the old folder away and run inferlo db migrate to start a new one, or create the tables with inferlo db push.`,
      expose: true,
    });
  }
  return s.tables as MigrationSnapshot["tables"];
}

const SQLITE_RENAMES: RenameDialect = { quote: q, indexName: (table, column, suffix) => `${table}_${column}_${suffix}` };

/**
 * Rebuild a table for column changes, as SQLite recommends: create the new table under a temporary name, copy the
 * rows (dropped columns left out, new columns filled by their defaults, NULLs in a column made required replaced by
 * its fixed default, integers converted to numbers), drop the old table, rename the new one and create its indexes
 * again. applySqliteMigrations turns foreign key enforcement off for this and checks every foreign key at the end.
 */
function rebuildSql(model: AnyModel, old: MigrationSnapshot["tables"][string], now: MigrationSnapshot["tables"][string]): string[] {
  const temporary = `inferlo_new_${model.name}`;
  const create = createTableSql(model).replace(/^CREATE TABLE IF NOT EXISTS "(?:[^"]|"")*"/, `CREATE TABLE ${q(temporary)}`);
  const columns = Object.keys(now.columns).filter((column) => column in old.columns);
  const values = columns.map((column) => {
    const before = old.columns[column]!;
    const after = now.columns[column]!;
    let value = q(column);
    if (before.type !== after.type) value = `CAST(${value} AS ${after.type})`;
    if (!before.notNull && after.notNull && after.default !== undefined) value = `COALESCE(${value}, ${after.default})`;
    return value;
  });
  return [
    create,
    `INSERT INTO ${q(temporary)} (${columns.map(q).join(", ")}) SELECT ${values.join(", ")} FROM ${q(model.name)}`,
    `DROP TABLE ${q(model.name)}`,
    `ALTER TABLE ${q(temporary)} RENAME TO ${q(model.name)}`,
    ...modelIndexes(model).map(([, sql]) => sql),
  ];
}

/** planMigration for SQLite (see the file comment). */
export function planSqliteMigration(models: readonly AnyModel[], previous: unknown, options: { allowDrop?: boolean; allowChange?: boolean; renames?: Readonly<Record<string, string>> }): MigrationPlan {
  const renamed = renameSnapshot(readSqliteSnapshot(previous), models, options.renames ?? {}, SQLITE_RENAMES);
  const before = renamed.tables;
  const statements: string[] = [];
  for (const step of renamed.steps) {
    if (step.kind === "table") statements.push(`ALTER TABLE ${q(step.from)} RENAME TO ${q(step.to)}`);
    else if (step.kind === "column") statements.push(`ALTER TABLE ${q(step.table)} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}`);
    else if (step.kind === "index") statements.push(`DROP INDEX ${q(step.from)}`, before[step.table]!.indexes[step.to]!);
    // CHECK and REFERENCES clauses are part of the column in SQLite and follow the rename themselves.
  }
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { inferlo: 2, dialect: "sqlite", tables: {} };
  const refused: string[] = [];
  const changedColumns: { table: string; column: string; changes: string[] }[] = [];
  const alterable: { table: string; column: string; changes: string[] }[] = [];
  const needDefault: string[] = [];
  const drops: string[] = [];
  for (const model of sorted) {
    const now = tableSnapshot(model);
    snapshot.tables[model.name] = now;
    const old = before[model.name];
    if (!old) {
      statements.push(createTableSql(model), ...modelIndexes(model).map(([, sql]) => sql));
      continue;
    }
    const dropIndexes: string[] = [];
    const dropColumns: string[] = [];
    let rebuild = false;
    for (const [name, sql] of Object.entries(old.indexes)) {
      if (!(name in now.indexes)) {
        drops.push(`drop index ${name}`);
        // A column's indexes go before the column: SQLite refuses to drop an indexed column.
        dropIndexes.push(`DROP INDEX IF EXISTS ${q(name)}`);
      } else if (now.indexes[name] !== sql) refused.push(`change index ${name}`);
    }
    for (const [column, description] of Object.entries(old.columns)) {
      if (!(column in now.columns)) {
        drops.push(`drop column ${model.name}.${column}`);
        dropColumns.push(`ALTER TABLE ${q(model.name)} DROP COLUMN ${q(column)}`);
        continue;
      }
      const current = now.columns[column]!;
      const changes = columnChanges(description, current);
      if (!changes.length) continue;
      if (isAlterable(description, current) && (description.type === current.type || (description.type === "INTEGER" && current.type === "REAL"))) {
        alterable.push({ table: model.name, column, changes });
        rebuild = true;
      } else {
        refused.push(`change column ${model.name}.${column}`);
        changedColumns.push({ table: model.name, column, changes });
      }
    }
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      const d = schema.def;
      if (!(columnName(field) in old.columns) && !d.optional && !d.nullable && d.kind !== "any" && fixedDefault(schema) === undefined) needDefault.push(`${model.name}.${columnName(field)}`);
    }
    if (rebuild) {
      statements.push(...rebuildSql(model, old, now));
      continue;
    }
    statements.push(...dropIndexes, ...dropColumns);
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      if (!(columnName(field) in old.columns)) statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN ${columnDefinition(field, schema, true)}`);
    }
    for (const [name, sql] of Object.entries(now.indexes)) if (!(name in old.indexes)) statements.push(sql);
  }
  const droppedTables = Object.keys(before).filter((table) => !(table in snapshot.tables));
  if (droppedTables.length) {
    drops.push(...droppedTables.map((table) => `drop table ${table}`));
    // SQLite drops one table per statement: a table goes after the dropped tables that reference it.
    const references = (from: string, to: string) => from !== to && Object.values(before[from]!.columns).some((c) => c.references?.table === to);
    const order: string[] = [];
    let remaining = [...droppedTables];
    while (remaining.length) {
      const free = remaining.filter((table) => !remaining.some((other) => references(other, table)));
      const next = free.length ? free : remaining;
      order.push(...next);
      remaining = remaining.filter((table) => !next.includes(table));
    }
    statements.push(...order.map((table) => `DROP TABLE IF EXISTS ${q(table)}`));
  }
  if (refused.length) {
    const explained = refused.map((change) => {
      const column = changedColumns.find((c) => change === `change column ${c.table}.${c.column}`);
      return column ? `${change} (${column.changes.join(", ")})` : change;
    });
    throw new InferloError("IL4013", `inferlo db migrate cannot generate these changes on SQLite yet: ${explained.join(", ")}.`, {
      fix: "On SQLite, column changes are generated by rebuilding the table, and type changes only from integer to number, because SQLite keeps values that do not fit a column's type instead of failing. Index changes are not generated yet. Undo these model changes, or write the SQL yourself in a new migration file (and update the models to match).",
      details: { changes: refused, columns: changedColumns },
      expose: true,
    });
  }
  if (drops.length && !options.allowDrop) {
    const hint = renameHint(before, sorted);
    throw new InferloError("IL4017", `Your model changes drop data: ${drops.join(", ")}.`, {
      fix: `${hint ? `If you renamed it, run inferlo db migrate --rename ${hint} (or pass { renames: { ... } }), which keeps the data. ` : ""}If you mean to delete this data, run inferlo db migrate --allow-drop (or planMigration(models, snapshot, { dialect: "sqlite", allowDrop: true })) and review the file. Otherwise restore the removed models, fields or indexes.`,
      details: { drops },
      expose: true,
    });
  }
  const changes = alterable.map((c) => `change column ${c.table}.${c.column} (${c.changes.join(", ")})`);
  if (changes.length && !options.allowChange) {
    throw new InferloError("IL4019", `Your model changes change existing columns: ${changes.join(", ")}.`, {
      fix: 'If you mean to change these columns, run inferlo db migrate --allow-change (or planMigration(models, snapshot, { dialect: "sqlite", allowChange: true })) and review the file. SQLite rebuilds the table: rows that do not fit the new definition (NULL left in a column made required, a removed enum value, ids the new referenced table does not have) fail --apply with IL4039 and the migration is rolled back. Otherwise undo the model changes.',
      details: { changes, columns: alterable },
      expose: true,
    });
  }
  if (needDefault.length) {
    throw new InferloError("IL4014", `New required column${needDefault.length > 1 ? "s" : ""} ${needDefault.join(", ")} on an existing table need a value for existing rows.`, {
      fix: 'Add .default(value) (a fixed value, not a function) or .optional() to the field, e.g. status: t.enum(["open", "closed"]).default("open").',
      details: { columns: needDefault },
      expose: true,
    });
  }
  return { statements, snapshot, drops, changes, renames: renamed.descriptions };
}

interface SqlDb {
  $sql(text: string, params?: unknown[]): Promise<DbRecord[]>;
  $transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}

/** applyMigrations on SQLite. The caller checked the names and computed the checksums. */
export async function applySqliteMigrations(db: SqlDb, sorted: readonly Migration[], sums: Map<string, string>, onEdited?: (names: string[]) => void): Promise<string[]> {
  await db.$sql(`CREATE TABLE IF NOT EXISTS "inferlo_migrations" ("name" TEXT PRIMARY KEY NOT NULL, "applied_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), "checksum" TEXT)`);
  const done = new Map((await db.$sql(`SELECT "name", "checksum" FROM "inferlo_migrations"`)).map((r) => [String(r.name), r.checksum == null ? null : String(r.checksum)]));
  const edited = sorted.filter((m) => done.has(m.name) && done.get(m.name) !== sums.get(m.name)).map((m) => m.name);
  if (edited.length) onEdited?.(edited);
  const applied: string[] = [];
  // Table rebuilds drop and re-create tables that others reference, so foreign keys are not enforced while a file
  // runs (SQLite ignores this pragma inside a transaction); every foreign key is checked before the file commits.
  const enforced = Number((await db.$sql("PRAGMA foreign_keys"))[0]?.foreign_keys ?? 0) === 1;
  if (enforced) await db.$sql("PRAGMA foreign_keys = OFF");
  try {
    for (const m of sorted) {
      if (done.has(m.name)) continue;
      // One transaction per file (BEGIN IMMEDIATE: one writer at a time), so a failing statement undoes the whole file.
      const ran = await db.$transaction(async (tx) => {
        if ((await tx.$sql(`SELECT 1 FROM "inferlo_migrations" WHERE "name" = ?`, [m.name])).length) return false;
        const statements = splitStatements(m.sql, { mysql: false });
        for (const [index, statement] of statements.entries()) {
          try {
            await tx.$sql(statement);
          } catch (error) {
            const reason = (error as Error).message;
            throw new InferloError("IL4039", `Migration ${m.name} failed at statement ${index + 1} of ${statements.length}: ${reason}`, {
              fix: `The migration was rolled back, so nothing in migrations/${m.name}.sql was applied. Fix the file (or the data the failing statement needs), then run inferlo db migrate --apply again.`,
              details: { migration: m.name, statement: index + 1, sql: statement },
              cause: error,
              expose: true,
            });
          }
        }
        if (enforced) {
          const broken = await tx.$sql("PRAGMA foreign_key_check");
          if (broken.length) {
            const first = broken[0]!;
            throw new InferloError("IL4039", `Migration ${m.name} leaves ${broken.length} row${broken.length === 1 ? "" : "s"} pointing at rows that do not exist (first: ${String(first.table)} row ${String(first.rowid)} -> ${String(first.parent)}).`, {
              fix: `The migration was rolled back. Delete or fix those rows (or point the reference at the right table) in a migration before this one, then run inferlo db migrate --apply again.`,
              details: { migration: m.name, foreignKeys: broken.slice(0, 20).map((r) => ({ table: r.table, rowid: r.rowid, parent: r.parent })) },
              expose: true,
            });
          }
        }
        await tx.$sql(`INSERT INTO "inferlo_migrations" ("name", "checksum") VALUES (?, ?)`, [m.name, sums.get(m.name)]);
        return true;
      });
      if (ran) applied.push(m.name);
    }
  } finally {
    if (enforced) await db.$sql("PRAGMA foreign_keys = ON");
  }
  return applied;
}
