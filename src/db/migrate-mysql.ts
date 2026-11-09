/**
 * Migration files for MySQL: planMigration(models, snapshot, { dialect: "mysql" }) and applyMigrations() on a
 * mysql() database.
 *
 * Generated: new tables (with their foreign keys), new columns (a required column needs a fixed default, IL4014),
 * new indexes, and with { allowDrop: true } drops of tables, columns (their foreign key first) and indexes, which
 * are otherwise refused with IL4017. With { allowChange: true } (otherwise IL4019) type, default, required/optional,
 * enum value and reference changes: MODIFY COLUMN with the whole new definition, the enum's CHECK constraint and the
 * reference's foreign key replaced. Type changes are generated only where MySQL converts strictly (between string
 * types, integer to number, numbers to and from strings); the others raise IL4013. Renames named with { renames }
 * become RENAME TO, RENAME COLUMN and RENAME INDEX, with the foreign keys named after them re-created.
 *
 * MySQL names a column's CHECK constraint itself (<table>_chk_<n>) and refuses to rename a column that one uses,
 * so enum changes and renames of enum columns look the constraint up in information_schema and drop it with a
 * prepared statement, then add the new one.
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
import { columnChanges, isAlterable, renameHint, renameSnapshot, type Migration, type MigrationPlan, type MigrationSnapshot, type MigrationSnapshotColumn, type RenameDialect } from "./migrate.ts";

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
    const other = s.dialect === "sqlite" ? "SQLite" : "PostgreSQL";
    throw new InferloError("IL4037", `migrations/snapshot.json and the migration files were written for ${other}, and this app uses MySQL.`, {
      fix: `Migration files are written for one database. Keep the ${other} migrations folder with the ${other} app; for MySQL, move the old folder away and run inferlo db migrate to start a new one, or create the tables with inferlo db push.`,
      expose: true,
    });
  }
  return s.tables as MigrationSnapshot["tables"];
}

const MYSQL_RENAMES: RenameDialect = { quote: q, indexName: (table, column, suffix) => constraintName(`${table}_${column}_${suffix}`) };

const str = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const fkeyName = (table: string, column: string) => constraintName(`${table}_${column}_fkey`);

/**
 * Drop the CHECK constraint of an enum column. MySQL names it itself (<table>_chk_<n>), so the statement is built
 * from information_schema and run as a prepared statement; when there is none, nothing is dropped.
 */
function dropCheckSql(table: string, column: string): string[] {
  const clause = `(${q(column)} in (`.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
  return [
    `SET @inferlo_sql = (SELECT IFNULL(CONCAT('ALTER TABLE ', ${str(q(table))}, ' ', GROUP_CONCAT(CONCAT('DROP CHECK \`', REPLACE(tc.CONSTRAINT_NAME, '\`', '\`\`'), '\`') SEPARATOR ', ')), 'DO 0') FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ${str(table)} AND tc.CONSTRAINT_TYPE = 'CHECK' AND cc.CHECK_CLAUSE LIKE ${str(clause)})`,
    "PREPARE inferlo_stmt FROM @inferlo_sql",
    "EXECUTE inferlo_stmt",
    "DEALLOCATE PREPARE inferlo_stmt",
  ];
}

const addCheckSql = (table: string, column: string, values: readonly string[]) => `ALTER TABLE ${q(table)} ADD CHECK (${q(column)} IN (${values.map(str).join(", ")}))`;

const addForeignKeySql = (table: string, column: string, references: NonNullable<MigrationSnapshotColumn["references"]>) =>
  `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fkeyName(table, column))} FOREIGN KEY (${q(column)}) REFERENCES ${q(references.table)} (\`id\`) ON DELETE ${references.onDelete.toUpperCase()}`;

const STRING_TYPE = /^(VARCHAR\(\d+\)|CHAR\(36\)|TEXT|MEDIUMTEXT)$/;
const NUMBER_TYPE = /^(INT|DOUBLE)$/;

/** Type changes MySQL converts strictly: a value that does not fit fails the statement instead of being changed. */
function convertsStrictly(from: string, to: string): boolean {
  if (STRING_TYPE.test(to)) return STRING_TYPE.test(from) || NUMBER_TYPE.test(from);
  if (NUMBER_TYPE.test(to)) return STRING_TYPE.test(from) || (from === "INT" && to === "DOUBLE");
  return false;
}

/** The statements for a type, default, required/optional, enum value and reference change (see isAlterable). */
function alterColumnSql(table: string, column: string, before: MigrationSnapshotColumn, now: MigrationSnapshotColumn): string[] {
  const out: string[] = [];
  const enumChanged = JSON.stringify(before.enum) !== JSON.stringify(now.enum);
  const referenceChanged = JSON.stringify(before.references) !== JSON.stringify(now.references);
  // The old constraints go first, so the new type, default and values are not checked against them.
  if (referenceChanged && before.references) out.push(`ALTER TABLE ${q(table)} DROP FOREIGN KEY ${q(fkeyName(table, column))}`);
  if (enumChanged && before.enum) out.push(...dropCheckSql(table, column));
  // Same as adding a required column with a default: existing rows get the default.
  if (!before.notNull && now.notNull && now.default !== undefined) out.push(`UPDATE ${q(table)} SET ${q(column)} = ${now.default} WHERE ${q(column)} IS NULL`);
  if (before.type !== now.type || before.notNull !== now.notNull || before.default !== now.default) {
    // MODIFY COLUMN replaces the whole definition (CHECK constraints stay).
    out.push(`ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${now.type}${now.default !== undefined ? ` DEFAULT ${now.default}` : ""}${now.notNull ? " NOT NULL" : " NULL"}`);
  }
  if (enumChanged && now.enum) out.push(addCheckSql(table, column, now.enum));
  if (referenceChanged && now.references) out.push(addForeignKeySql(table, column, now.references));
  return out;
}

/** renameSnapshot with the statements MySQL needs. */
function applyMysqlRenames(before: MigrationSnapshot["tables"], models: readonly AnyModel[], renames: Readonly<Record<string, string>>) {
  const { tables, steps, descriptions } = renameSnapshot(before, models, renames, MYSQL_RENAMES);
  const statements: string[] = [];
  for (const step of steps) {
    if (step.kind === "table") statements.push(`ALTER TABLE ${q(step.from)} RENAME TO ${q(step.to)}`);
    else if (step.kind === "index") statements.push(`ALTER TABLE ${q(step.table)} RENAME INDEX ${q(step.from)} TO ${q(step.to)}`);
    else if (step.kind === "column") {
      // MySQL refuses to rename a column its CHECK constraint uses: drop it, rename, add it again.
      const values = step.column.enum;
      if (values) statements.push(...dropCheckSql(step.table, step.from));
      statements.push(`ALTER TABLE ${q(step.table)} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}`);
      if (values) statements.push(addCheckSql(step.table, step.to, values));
    } else if (step.suffix === "fkey") {
      // MySQL cannot rename a foreign key: drop it and add it under its new name. The index MySQL created for it
      // has the old name too, unless the column has an index of its own.
      const from = fkeyName(step.oldTable, step.oldColumn);
      const to = fkeyName(step.table, step.column);
      if (from === to) continue;
      statements.push(`ALTER TABLE ${q(step.table)} DROP FOREIGN KEY ${q(from)}`);
      const ownIndex = Object.values(tables[step.table]!.indexes).some((sql) => sql.endsWith(`(${q(step.column)})`));
      if (!ownIndex) statements.push(`ALTER TABLE ${q(step.table)} RENAME INDEX ${q(from)} TO ${q(to)}`);
      statements.push(addForeignKeySql(step.table, step.column, step.definition.references!));
    }
    // CHECK constraints follow a renamed table in MySQL (<table>_chk_<n>), so they need nothing.
  }
  return { tables, statements, descriptions };
}

/** planMigration for MySQL (see the file comment). */
export function planMysqlMigration(models: readonly AnyModel[], previous: unknown, options: { allowDrop?: boolean; allowChange?: boolean; renames?: Readonly<Record<string, string>> }): MigrationPlan {
  const renamed = applyMysqlRenames(readMysqlSnapshot(previous), models, options.renames ?? {});
  const before = renamed.tables;
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { inferlo: 2, dialect: "mysql", tables: {} };
  const statements: string[] = [...renamed.statements];
  const refused: string[] = [];
  const changedColumns: { table: string; column: string; changes: string[] }[] = [];
  const alterable: { table: string; column: string; changes: string[] }[] = [];
  const needDefault: string[] = [];
  const drops: string[] = [];
  /** Foreign keys added by column changes, after every new table they may point at. */
  const addForeignKeys: string[] = [];
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
    const alterStatements: string[] = [];
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
        if (description.references) dropColumns.push(`ALTER TABLE ${q(model.name)} DROP FOREIGN KEY ${q(fkeyName(model.name, column))}`);
        dropColumns.push(`ALTER TABLE ${q(model.name)} DROP COLUMN ${q(column)}`);
        continue;
      }
      const current = now.columns[column]!;
      const changes = columnChanges(description, current);
      if (!changes.length) continue;
      if (isAlterable(description, current) && (description.type === current.type || convertsStrictly(description.type, current.type))) {
        alterable.push({ table: model.name, column, changes });
        const sql = alterColumnSql(model.name, column, description, current);
        const addsForeignKey = JSON.stringify(description.references) !== JSON.stringify(current.references) && current.references;
        if (addsForeignKey) addForeignKeys.push(sql.pop()!);
        alterStatements.push(...sql);
      } else {
        refused.push(`change column ${model.name}.${column}`);
        changedColumns.push({ table: model.name, column, changes });
      }
    }
    statements.push(...dropIndexes, ...dropColumns, ...alterStatements);
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
  statements.push(...addForeignKeys);
  const droppedTables = Object.keys(before).filter((table) => !(table in snapshot.tables));
  if (droppedTables.length) {
    drops.push(...droppedTables.map((table) => `drop table ${table}`));
    // One statement, so foreign keys between the dropped tables do not matter; a table still referenced by a
    // table that stays makes the migration fail instead of breaking the reference.
    statements.push(`DROP TABLE IF EXISTS ${droppedTables.map(q).join(", ")}`);
  }
  if (refused.length) {
    const explained = refused.map((change) => {
      const column = changedColumns.find((c) => change === `change column ${c.table}.${c.column}`);
      return column ? `${change} (${column.changes.join(", ")})` : change;
    });
    throw new InferloError("IL4013", `inferlo db migrate cannot generate these changes on MySQL yet: ${explained.join(", ")}.`, {
      fix: "On MySQL, type changes are generated only between string types, from integer to number, and between numbers and strings, because MySQL converts the others silently or differently (to or from boolean, date and JSON columns, and number to integer, which rounds). Index changes are not generated yet. Undo these model changes, or write the SQL yourself in a new migration file (and update the models to match).",
      details: { changes: refused, columns: changedColumns },
      expose: true,
    });
  }
  if (drops.length && !options.allowDrop) {
    const hint = renameHint(before, sorted);
    throw new InferloError("IL4017", `Your model changes drop data: ${drops.join(", ")}.`, {
      fix: `${hint ? `If you renamed it, run inferlo db migrate --rename ${hint} (or pass { renames: { ... } }), which keeps the data. ` : ""}If you mean to delete this data, run inferlo db migrate --allow-drop (or planMigration(models, snapshot, { dialect: "mysql", allowDrop: true })) and review the file. Otherwise restore the removed models, fields or indexes.`,
      details: { drops },
      expose: true,
    });
  }
  const changes = alterable.map((c) => `change column ${c.table}.${c.column} (${c.changes.join(", ")})`);
  if (changes.length && !options.allowChange) {
    throw new InferloError("IL4019", `Your model changes change existing columns: ${changes.join(", ")}.`, {
      fix: 'If you mean to change these columns, run inferlo db migrate --allow-change (or planMigration(models, snapshot, { dialect: "mysql", allowChange: true })) and review the file. On MySQL a statement that fails (a value that does not convert or fit, NULL left in a column made required, rows using a removed enum value, or ids the new referenced table does not have) stops --apply with IL4038. Otherwise undo the model changes.',
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

/**
 * Split a migration file into statements at semicolons outside strings, quoted names and comments.
 * Comments are kept with the statement that follows them; empty statements are dropped. MySQL also has # comments
 * and backslash escapes in strings; SQLite (`{ mysql: false }`) has neither.
 */
export function splitStatements(sql: string, { mysql = true }: { mysql?: boolean } = {}): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text.replace(mysql ? /--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g : /--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(text);
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (mysql && sql[i] === "\\" && c !== "`") i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if ((c === "-" && sql[i + 1] === "-") || (mysql && c === "#")) {
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
