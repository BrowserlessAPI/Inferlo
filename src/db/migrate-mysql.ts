/**
 * Migration files for MySQL: planMigration(models, snapshot, { dialect: "mysql" }) and applyMigrations() on a
 * mysql() database.
 *
 * Generated: new tables (with their foreign keys), new columns (a required column needs a fixed default, IL4014),
 * new indexes, and with { allowDrop: true } drops of tables, columns (their foreign key first) and indexes, which
 * are otherwise refused with IL4017. Column changes and renames are refused with IL4013 for now; write those
 * statements yourself in a new migration file.
 *
 * MySQL commits each schema change (CREATE, ALTER, DROP) as it runs, so a file cannot be rolled back as a whole:
 * the statements run one by one, the file is recorded once all of them ran, and a failure names the statement
 * (IL4038). A named lock (GET_LOCK) makes concurrent deploys apply each file once.
 */
import { InferloError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnDefinition, columnType, constraintName, createTableSql, defaultSql, foreignKeySql, modelIndexes, sortByReferences } from "./mysql.ts";
import type { DbRecord } from "./types.ts";
import type { Migration, MigrationPlan, MigrationSnapshot, MigrationSnapshotColumn } from "./migrate.ts";

const q = (identifier: string) => `\`${identifier.replace(/`/g, "``")}\``;

const SYSTEM_COLUMNS: Record<string, MigrationSnapshotColumn> = {
  id: { type: "CHAR(36)", notNull: true, primaryKey: true },
  created_at: { type: "DATETIME(3)", notNull: true },
  updated_at: { type: "DATETIME(3)", notNull: true },
};

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
  const columns: Record<string, MigrationSnapshotColumn> = { ...SYSTEM_COLUMNS };
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) columns[columnName(field)] = columnSnapshot(schema);
  return { columns, indexes: Object.fromEntries(modelIndexes(model)) };
}

/** Read a MySQL snapshot. Snapshots written for PostgreSQL are refused (IL4037): their SQL and types differ. */
export function readMysqlSnapshot(input: unknown): MigrationSnapshot["tables"] {
  if (input === undefined) return {};
  const s = input as { inferlo?: unknown; dialect?: unknown; tables?: unknown };
  if (!s || typeof s !== "object" || s.inferlo !== 2 || typeof s.tables !== "object" || s.tables === null) {
    throw new InferloError("IL4015", "migrations/snapshot.json is not a valid Inferlo snapshot.", {
      fix: "migrations/snapshot.json must be the file written by inferlo db migrate. Restore it from version control; do not edit it by hand.",
      expose: true,
    });
  }
  if (s.dialect !== "mysql") {
    throw new InferloError("IL4037", "migrations/snapshot.json and the migration files were written for PostgreSQL, and this app uses MySQL.", {
      fix: "Migration files are written for one database. Keep the PostgreSQL migrations folder with the PostgreSQL app; for MySQL, move the old folder away and run inferlo db migrate to start a new one, or create the tables with inferlo db push.",
      expose: true,
    });
  }
  return s.tables as MigrationSnapshot["tables"];
}

const describeColumn = (c: MigrationSnapshotColumn) => JSON.stringify([c.type, c.notNull, c.default ?? null, c.enum ?? null, c.references ?? null, Boolean(c.primaryKey)]);

/** planMigration for MySQL: new tables, columns and indexes, and drops with allowDrop (see the file comment). */
export function planMysqlMigration(models: readonly AnyModel[], previous: unknown, options: { allowDrop?: boolean; allowChange?: boolean; renames?: Readonly<Record<string, string>> }): MigrationPlan {
  const before = readMysqlSnapshot(previous);
  if (options.renames && Object.keys(options.renames).length) refuse(Object.entries(options.renames).map(([from, to]) => `rename ${from} -> ${to}`));
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { inferlo: 2, dialect: "mysql", tables: {} };
  const statements: string[] = [];
  const refused: string[] = [];
  const needDefault: string[] = [];
  const drops: string[] = [];
  for (const model of sorted) {
    const now = tableSnapshot(model);
    snapshot.tables[model.name] = now;
    const old = before[model.name];
    if (!old) {
      statements.push(createTableSql(model));
      statements.push(...modelIndexes(model).map(([, sql]) => sql));
      continue;
    }
    const dropIndexes: string[] = [];
    const dropColumns: string[] = [];
    for (const [name, sql] of Object.entries(old.indexes)) {
      if (!(name in now.indexes)) {
        drops.push(`drop index ${name}`);
        dropIndexes.push(`DROP INDEX ${q(name)} ON ${q(model.name)}`);
      } else if (now.indexes[name] !== sql) refused.push(`change index ${name}`);
    }
    for (const [column, description] of Object.entries(old.columns)) {
      if (!(column in now.columns)) {
        drops.push(`drop column ${model.name}.${column}`);
        // MySQL refuses to drop a column that a foreign key uses, so the constraint goes first.
        if (description.references) dropColumns.push(`ALTER TABLE ${q(model.name)} DROP FOREIGN KEY ${q(constraintName(`${model.name}_${column}_fkey`))}`);
        dropColumns.push(`ALTER TABLE ${q(model.name)} DROP COLUMN ${q(column)}`);
      } else if (describeColumn(description) !== describeColumn(now.columns[column]!)) refused.push(`change column ${model.name}.${column}`);
    }
    statements.push(...dropIndexes, ...dropColumns);
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      const column = columnName(field);
      if (column in old.columns) continue;
      const d = schema.def;
      if (!d.optional && !d.nullable && d.kind !== "any" && defaultSql(schema) === undefined) needDefault.push(`${model.name}.${column}`);
      statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN ${columnDefinition(field, schema, true)}`);
      if (d.kind === "ref" && d.refTable) statements.push(`ALTER TABLE ${q(model.name)} ADD ${foreignKeySql(model.name, field, schema)}`);
    }
    for (const [name, sql] of Object.entries(now.indexes)) if (!(name in old.indexes)) statements.push(sql);
  }
  const droppedTables = Object.keys(before).filter((table) => !(table in snapshot.tables));
  if (droppedTables.length) {
    drops.push(...droppedTables.map((table) => `drop table ${table}`));
    // One statement, so foreign keys between the dropped tables do not matter; a table still referenced by a
    // table that stays makes the migration fail instead of breaking the reference.
    statements.push(`DROP TABLE IF EXISTS ${droppedTables.map(q).join(", ")}`);
  }
  if (refused.length) refuse(refused);
  if (drops.length && !options.allowDrop) {
    const hint = renameHint(before, sorted);
    throw new InferloError("IL4017", `Your model changes drop data: ${drops.join(", ")}.`, {
      fix: `${hint ? `If you renamed it, undo the rename for now: renames are not generated on MySQL yet (write ALTER TABLE ... RENAME COLUMN yourself in a new migration file). ` : ""}If you mean to delete this data, run inferlo db migrate --allow-drop (or planMigration(models, snapshot, { dialect: "mysql", allowDrop: true })) and review the file. Otherwise restore the removed models, fields or indexes.`,
      details: { drops },
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
  return { statements, snapshot, drops, changes: [], renames: [] };
}

/** True when a table lost one column and gained one, or one table was replaced by another: probably a rename. */
function renameHint(before: MigrationSnapshot["tables"], models: readonly AnyModel[]): boolean {
  for (const model of models) {
    const old = before[model.name];
    if (!old) continue;
    const columns = Object.keys(tableSnapshot(model).columns);
    if (Object.keys(old.columns).filter((c) => !columns.includes(c)).length === 1 && columns.filter((c) => !(c in old.columns)).length === 1) return true;
  }
  const names = new Set(models.map((m) => m.name));
  return Object.keys(before).filter((t) => !names.has(t)).length === 1 && models.filter((m) => !(m.name in before)).length === 1;
}

function refuse(changes: string[]): never {
  throw new InferloError("IL4013", `inferlo db migrate cannot generate these changes on MySQL yet: ${changes.join(", ")}.`, {
    fix: "On MySQL, new tables, columns and indexes, and drops with --allow-drop, are generated. For column changes and renames, undo these model changes, or write the SQL yourself in a new migration file (and update the models to match).",
    details: { changes },
    expose: true,
  });
}

/**
 * Split a migration file into statements at semicolons outside strings, quoted names and comments.
 * Comments are kept with the statement that follows them; empty statements are dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(text);
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && c !== "`") i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return out;
}

interface SqlDb {
  $sql(text: string, params?: unknown[]): Promise<DbRecord[]>;
  $transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}

const LOCK = "inferlo_migrations";

/** applyMigrations on MySQL. The caller checked the names and computed the checksums. */
export async function applyMysqlMigrations(db: SqlDb, sorted: readonly Migration[], sums: Map<string, string>, onEdited?: (names: string[]) => void): Promise<string[]> {
  // One connection for the whole run (a transaction pins it), because GET_LOCK belongs to the connection. Schema
  // changes commit as they run; the lock, not the transaction, keeps two deploys apart.
  return db.$transaction(async (tx) => {
    const locked = await tx.$sql("SELECT GET_LOCK(?, 60) AS ok", [LOCK]);
    if (Number(locked[0]?.ok) !== 1) {
      throw new InferloError("IL4038", "Could not take the migration lock: another inferlo db migrate --apply has been running for 60 seconds.", {
        fix: "Wait for the other deploy to finish, then run inferlo db migrate --apply again.",
        expose: true,
      });
    }
    try {
      await tx.$sql(
        "CREATE TABLE IF NOT EXISTS `inferlo_migrations` (`name` VARCHAR(200) NOT NULL PRIMARY KEY, `applied_at` DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)), `checksum` CHAR(64)) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin",
      );
      const done = new Map((await tx.$sql("SELECT `name`, `checksum` FROM `inferlo_migrations`")).map((r) => [String(r.name), r.checksum == null ? null : String(r.checksum)]));
      const edited = sorted.filter((m) => done.has(m.name) && done.get(m.name) !== sums.get(m.name)).map((m) => m.name);
      if (edited.length) onEdited?.(edited);
      const applied: string[] = [];
      for (const m of sorted) {
        if (done.has(m.name)) continue;
        const statements = splitStatements(m.sql);
        for (const [index, statement] of statements.entries()) {
          try {
            await tx.$sql(statement);
          } catch (error) {
            const reason = (error as { sqlMessage?: string; message?: string }).sqlMessage ?? (error as Error).message;
            throw new InferloError("IL4038", `Migration ${m.name} failed at statement ${index + 1} of ${statements.length}: ${reason}`, {
              fix: `MySQL commits each schema change as it runs, so the ${index} statement${index === 1 ? "" : "s"} before it ${index === 1 ? "was" : "were"} applied and the migration is not recorded. Fix the database or the file so the remaining statements can run (remove the ones that already ran from migrations/${m.name}.sql), then run inferlo db migrate --apply again.`,
              details: { migration: m.name, statement: index + 1, sql: statement },
              cause: error,
              expose: true,
            });
          }
        }
        await tx.$sql("INSERT INTO `inferlo_migrations` (`name`, `checksum`) VALUES (?, ?)", [m.name, sums.get(m.name)]);
        await tx.$sql("COMMIT");
        applied.push(m.name);
      }
      return applied;
    } finally {
      await tx.$sql("SELECT RELEASE_LOCK(?)", [LOCK]);
    }
  });
}
