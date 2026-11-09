/**
 * Versioned SQL migrations (PostgreSQL).
 *
 *   inferlo db migrate add_due_dates   # writes migrations/0002_add_due_dates.sql
 *   inferlo db migrate --apply         # runs pending files, recorded in "inferlo_migrations"
 *
 * planMigration compares your models with migrations/snapshot.json (the models as of the last
 * generated migration) and returns the SQL for the difference. Additive changes are generated
 * directly. Drops of tables, columns and indexes delete data, so they are refused with IL4017
 * unless you pass { allowDrop: true } (inferlo db migrate --allow-drop). Type, default, required and
 * enum value and reference changes are refused with IL4019 unless you pass { allowChange: true }
 * (--allow-change). A renamed table or column looks like a drop plus an add, so renames are only
 * generated when you name them in { renames: { "notes.color": "notes.colour" } } (--rename); index
 * changes are refused with IL4013, so nothing is lost silently. Snapshots in the
 * 0.2.0 format (inferlo: 1) are read and upgraded; plans always return the current format (inferlo: 2).
 */
import { InferloError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnDefinition, columnType, createTableSql, defaultSql, modelIndexes, needsVectorExtension, sortByReferences, SYSTEM_COLUMNS, VECTOR_EXTENSION } from "./postgres.ts";
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
  inferlo: 2;
  tables: Record<string, { columns: Record<string, MigrationSnapshotColumn>; indexes: Record<string, string> }>;
}

/** The snapshot format written by Inferlo 0.2.0 (each column as its SQL definition). planMigration upgrades it. */
export interface MigrationSnapshotV1 {
  inferlo: 1;
  tables: Record<string, { columns: Record<string, string>; indexes: Record<string, string> }>;
}

export interface MigrationPlan {
  /** SQL statements to put in the new migration file, in order. Empty when nothing changed. */
  statements: string[];
  /** Snapshot to save after writing the file. */
  snapshot: MigrationSnapshot;
  /** The drops included in `statements`, e.g. "drop column tasks.notes". Empty unless allowDrop was set. */
  drops: string[];
  /** The column changes included in `statements`, e.g. "change column tasks.done (default false -> none)". Empty unless allowChange was set. */
  changes: string[];
  /** The renames included in `statements`, e.g. "rename column notes.color -> notes.colour". Empty unless renames were given. */
  renames: string[];
}

export interface PlanMigrationOptions {
  /** Generate DROP statements for removed tables, columns and indexes. These delete data. Default false. */
  allowDrop?: boolean;
  /**
   * Generate type, default, required/optional, enum value and reference changes of existing columns
   * (ALTER COLUMN ... TYPE, SET DEFAULT, DROP DEFAULT, SET NOT NULL, DROP NOT NULL, and replacing the
   * enum's CHECK constraint or the reference's foreign key constraint). Changing a reference's table
   * fails at apply time (IL4031) if rows point at ids the new table does not have. Changing the type fails at apply time (IL4022) if an existing value does not
   * convert. Making a column required fails at apply time (IL4020) if rows still have NULL in it,
   * unless the field has a fixed default, which fills them. Removing an enum value fails at apply
   * time (IL4021) if rows still use it. Default false.
   */
  allowChange?: boolean;
  /**
   * Tables and columns you renamed, from the old name to the new one: { notes: "memos" } for a table,
   * { "notes.color": "notes.colour" } for a column (field names or column names; the table on the
   * right is the table's new name). They become ALTER TABLE ... RENAME statements, together with the
   * indexes and constraints named after them, instead of a drop plus an add that loses the data.
   * Invalid renames raise IL4032.
   */
  renames?: Readonly<Record<string, string>>;
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
 * Parse a column definition as written by Inferlo 0.2.0 (columnDefinition) into its structured form.
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

function invalidSnapshot(fix = "migrations/snapshot.json must be the file written by inferlo db migrate. Restore it from version control; do not edit it by hand."): never {
  throw new InferloError("IL4015", "The migration snapshot is not valid.", { fix, expose: true });
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

/** Validate a snapshot and return it in the current (inferlo: 2) format. */
function readSnapshot(input: unknown): MigrationSnapshot {
  // Snapshots written before the rename from Kairo use the key "kairo" instead of "inferlo".
  const previous = isRecord(input) && input.inferlo === undefined && "kairo" in input ? { ...input, inferlo: input["kairo"] } : input;
  if (!isRecord(previous) || (previous.inferlo !== 1 && previous.inferlo !== 2) || !isRecord(previous.tables)) invalidSnapshot();
  const tables: MigrationSnapshot["tables"] = {};
  for (const [name, table] of Object.entries(previous.tables)) {
    if (!isRecord(table) || !isRecord(table.columns) || !isRecord(table.indexes)) invalidSnapshot();
    const columns: Record<string, MigrationSnapshotColumn> = {};
    for (const [column, value] of Object.entries(table.columns)) {
      const parsed = previous.inferlo === 1 ? (typeof value === "string" ? parseColumnSql(value) : undefined) : isColumn(value) ? value : undefined;
      if (!parsed) {
        invalidSnapshot(
          `Column ${name}.${column} in migrations/snapshot.json is not in the format inferlo db migrate writes. Restore the file from version control; do not edit it by hand.`,
        );
      }
      columns[column] = parsed;
    }
    tables[name] = { columns, indexes: table.indexes as Record<string, string> };
  }
  return { inferlo: 2, tables };
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

/** Changes planMigration can generate with allowChange: only the type, default, required/optional, enum values and reference differ. */
function isAlterable(before: MigrationSnapshotColumn, now: MigrationSnapshotColumn): boolean {
  return columnChanges({ ...before, type: now.type, notNull: now.notNull, default: now.default, enum: now.enum, references: now.references }, now).length === 0;
}

const isString = (type: string) => type === "text" || type.startsWith("varchar(");

/**
 * The USING clause for ALTER COLUMN ... TYPE, or "" when Postgres converts the values itself.
 * Every conversion is strict: a value that does not fit fails the migration (IL4022) instead of
 * being cut, rounded or set to NULL.
 *   - to text or varchar(n): no USING (too long values fail, they are not cut);
 *   - integer to double precision: no USING;
 *   - from jsonb: the JSON value's text ("hello", not "\"hello\""), then converted;
 *   - to jsonb: to_jsonb(value), so text becomes a JSON string;
 *   - boolean to integer or double precision: true is 1, false is 0;
 *   - anything else goes through the value's text, so 2.5 does not become the integer 3.
 */
function usingSql(column: string, from: string, to: string): string {
  const c = q(column);
  if (to === "jsonb") return ` USING to_jsonb(${c})`;
  if (from === "jsonb") return isString(to) ? ` USING ${c} #>> '{}'` : ` USING (${c} #>> '{}')::${to}`;
  if (isString(to)) return "";
  if (from === "integer" && to === "double precision") return "";
  if (from === "boolean" && to === "integer") return ` USING ${c}::integer`;
  if (from === "boolean" && to === "double precision") return ` USING ${c}::integer::double precision`;
  return ` USING ${c}::text::${to}`;
}

/**
 * The name Postgres gives a constraint written inline in a column definition: "<table>_<column>_check"
 * for an enum's CHECK and "<table>_<column>_fkey" for a reference's foreign key, with table and column
 * shortened so it fits in 63 bytes, the same way Postgres shortens it (makeObjectName: trim the longer
 * part one byte at a time).
 */
function constraintName(table: string, column: string, suffix: "check" | "fkey"): string {
  const encoder = new TextEncoder();
  const a = encoder.encode(table);
  const b = encoder.encode(column);
  let n1 = a.length;
  let n2 = b.length;
  const available = 63 - "_".length - `_${suffix}`.length;
  while (n1 + n2 > available) {
    if (n1 > n2) n1--;
    else n2--;
  }
  // Never cut a multi-byte character in half (pg_mbcliplen).
  const clip = (bytes: Uint8Array, n: number) => {
    while (n > 0 && n < bytes.length && (bytes[n]! & 0xc0) === 0x80) n--;
    return new TextDecoder().decode(bytes.subarray(0, n));
  };
  return `${clip(a, n1)}_${clip(b, n2)}_${suffix}`;
}

/** ALTER statements for a type, default, required/optional, enum value and reference change (see isAlterable). */
function alterColumnSql(table: string, column: string, before: MigrationSnapshotColumn, now: MigrationSnapshotColumn): string[] {
  const alter = `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)}`;
  const out: string[] = [];
  const enumChanged = JSON.stringify(before.enum) !== JSON.stringify(now.enum);
  const typeChanged = before.type !== now.type;
  const check = q(constraintName(table, column, "check"));
  const referenceChanged = JSON.stringify(before.references) !== JSON.stringify(now.references);
  const foreignKey = q(constraintName(table, column, "fkey"));
  // The old constraints go first, so filling NULL rows with a new enum default is allowed and a type
  // change does not have to match the old referenced column. No IF EXISTS: if a constraint has another
  // name, the migration fails instead of keeping it.
  if (referenceChanged && before.references) out.push(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${foreignKey}`);
  if (enumChanged && before.enum) out.push(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${check}`);
  if (before.notNull && !now.notNull) out.push(`${alter} DROP NOT NULL`);
  if (typeChanged) {
    // Postgres does not convert a default together with the values, so the old default goes
    // first and the new one is set after the type change.
    if (before.default !== undefined) out.push(`${alter} DROP DEFAULT`);
    out.push(`${alter} TYPE ${now.type}${usingSql(column, before.type, now.type)}`);
    if (now.default !== undefined) out.push(`${alter} SET DEFAULT ${now.default}`);
  } else if (before.default !== now.default) out.push(now.default === undefined ? `${alter} DROP DEFAULT` : `${alter} SET DEFAULT ${now.default}`);
  if (!before.notNull && now.notNull) {
    // Same as adding a required column with a default: existing rows get the default.
    if (now.default !== undefined) out.push(`UPDATE ${q(table)} SET ${q(column)} = ${now.default} WHERE ${q(column)} IS NULL`);
    out.push(`${alter} SET NOT NULL`);
  }
  if (enumChanged && now.enum) {
    const values = now.enum.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
    out.push(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${check} CHECK (${q(column)} IN (${values}))`);
  }
  if (referenceChanged && now.references) {
    // The same constraint as a column definition with REFERENCES ("<table>_<column>_fkey"), checked against every existing row.
    out.push(
      `ALTER TABLE ${q(table)} ADD CONSTRAINT ${foreignKey} FOREIGN KEY (${q(column)}) REFERENCES ${q(now.references.table)}("id") ON DELETE ${now.references.onDelete.toUpperCase()}`,
    );
  }
  return out;
}

function invalidRename(problem: string): never {
  throw new InferloError("IL4032", `Invalid rename: ${problem}`, {
    fix: 'Name each rename as old=new with the names in migrations/snapshot.json on the left and in your models on the right: --rename notes=memos for a table, --rename notes.color=notes.colour for a column (after a table rename, the right side uses the new table name: --rename notes.color=memos.colour).',
    expose: true,
  });
}

/**
 * Applies the renames to the previous snapshot's tables, so the rest of the plan compares like with
 * like, and returns the RENAME statements: tables, then columns, then the indexes and constraints
 * Postgres named after them (which keep their old names otherwise).
 */
function applyRenames(
  before: MigrationSnapshot["tables"],
  models: readonly AnyModel[],
  renames: Readonly<Record<string, string>>,
): { tables: MigrationSnapshot["tables"]; statements: string[]; descriptions: string[] } {
  const entries = Object.entries(renames);
  if (!entries.length) return { tables: before, statements: [], descriptions: [] };
  const now = new Map(models.map((m) => [m.name, new Set(Object.keys(tableSnapshot(m).columns))]));
  const tables: MigrationSnapshot["tables"] = structuredClone(before);
  const statements: string[] = [];
  const descriptions: string[] = [];
  const tableRenames = new Map<string, string>();
  const columnRenames: { table: string; from: string; to: string }[] = [];
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const [from, to] of entries) {
    if (typeof to !== "string") invalidRename(`${JSON.stringify(from)} must map to a string.`);
    const left = from.split(".");
    const right = to.split(".");
    if (left.length !== right.length || left.length > 2 || ![...left, ...right].every((part) => NAME.test(part))) {
      invalidRename(`"${from}=${to}" is not table=table or table.column=table.column.`);
    }
    if (left.length === 1) {
      if (!(from in before)) invalidRename(`there is no table "${from}" in migrations/snapshot.json.`);
      if (to in before) invalidRename(`table "${to}" already exists in migrations/snapshot.json.`);
      if (!now.has(to)) invalidRename(`there is no model "${to}".`);
      if (now.has(from)) invalidRename(`model "${from}" still exists, so table "${from}" was not renamed.`);
      if ([...tableRenames.values()].includes(to)) invalidRename(`two tables are renamed to "${to}".`);
      tableRenames.set(from, to);
    } else {
      columnRenames.push({ table: left[0]!, from: columnName(left[1]!), to: `${right[0]}.${columnName(right[1]!)}` });
    }
  }
  for (const [from, to] of tableRenames) {
    tables[to] = tables[from]!;
    delete tables[from];
    statements.push(`ALTER TABLE ${q(from)} RENAME TO ${q(to)}`);
    descriptions.push(`rename table ${from} -> ${to}`);
  }
  // Foreign keys follow a renamed table in Postgres; the snapshot has to say so too.
  for (const table of Object.values(tables)) {
    for (const column of Object.values(table.columns)) {
      if (column.references && tableRenames.has(column.references.table)) column.references = { ...column.references, table: tableRenames.get(column.references.table)! };
    }
  }
  /** The old table and column of each column of a renamed table or renamed column, by new table and column. */
  const oldNames = new Map<string, Map<string, [table: string, column: string]>>();
  const remember = (table: string, column: string, old: [string, string]) => {
    if (!oldNames.has(table)) oldNames.set(table, new Map());
    oldNames.get(table)!.set(column, old);
  };
  for (const [from, to] of tableRenames) for (const column of Object.keys(tables[to]!.columns)) remember(to, column, [from, column]);
  const renamedColumns = new Set<string>();
  for (const { table, from, to } of columnRenames) {
    const [toTable, toColumn] = to.split(".") as [string, string];
    const current = tableRenames.get(table) ?? table;
    if (!(table in before)) invalidRename(`there is no table "${table}" in migrations/snapshot.json.`);
    if (toTable !== current) invalidRename(`a column stays in its table: "${table}.${from}" can only become "${current}.<column>".`);
    const columns = tables[current]!.columns;
    if (!(from in columns)) invalidRename(`there is no column "${table}.${from}" in migrations/snapshot.json.`);
    if (toColumn in columns) invalidRename(`column "${current}.${toColumn}" already exists in migrations/snapshot.json.`);
    if (!now.get(current)?.has(toColumn)) invalidRename(`model "${current}" has no field for column "${toColumn}".`);
    if (now.get(current)!.has(from)) invalidRename(`model "${current}" still has column "${from}", so it was not renamed.`);
    if (renamedColumns.has(`${current}.${from}`)) invalidRename(`column "${table}.${from}" is renamed twice.`);
    renamedColumns.add(`${current}.${from}`);
    columns[toColumn] = columns[from]!;
    delete columns[from];
    statements.push(`ALTER TABLE ${q(current)} RENAME COLUMN ${q(from)} TO ${q(toColumn)}`);
    descriptions.push(`rename column ${table}.${from} -> ${current}.${toColumn}`);
    remember(current, toColumn, [oldNames.get(current)?.get(from)?.[0] ?? table, from]);
    oldNames.get(current)?.delete(from);
  }
  // Indexes and the CHECK and foreign key constraints are named after the table and column; give them the names Inferlo now expects.
  for (const [table, columns] of oldNames) {
    const snapshot = tables[table]!;
    for (const [column, [oldTable, oldColumn]] of columns) {
      if (oldTable === table && oldColumn === column) continue;
      const definition = snapshot.columns[column]!;
      for (const [present, suffix] of [[definition.enum, "check"], [definition.references, "fkey"]] as const) {
        if (!present) continue;
        const from = constraintName(oldTable, oldColumn, suffix);
        const to = constraintName(table, column, suffix);
        if (from !== to) statements.push(`ALTER TABLE ${q(table)} RENAME CONSTRAINT ${q(from)} TO ${q(to)}`);
      }
      for (const suffix of ["key", "idx"]) {
        const from = `${oldTable}_${oldColumn}_${suffix}`;
        const sql = snapshot.indexes[from];
        if (sql === undefined) continue;
        const to = `${table}_${column}_${suffix}`;
        const on = sql.indexOf(` ON ${q(oldTable)} `);
        if (on === -1) continue;
        delete snapshot.indexes[from];
        snapshot.indexes[to] = sql.slice(0, on).replace(q(from), q(to)) + ` ON ${q(table)} ` + sql.slice(on + ` ON ${q(oldTable)} `.length).replaceAll(q(oldColumn), q(column));
        statements.push(`ALTER INDEX ${q(from)} RENAME TO ${q(to)}`);
      }
    }
  }
  return { tables, statements, descriptions };
}

/** SQL to bring the database from `previous` (or an empty database) to `models`. */
export function planMigration(
  models: readonly AnyModel[],
  previous?: MigrationSnapshot | MigrationSnapshotV1,
  options: PlanMigrationOptions = {},
): MigrationPlan {
  const renamed = applyRenames(previous === undefined ? {} : readSnapshot(previous).tables, models, options.renames ?? {});
  const before = renamed.tables;
  const sorted = sortByReferences([...models]);
  const snapshot: MigrationSnapshot = { inferlo: 2, tables: {} };
  const statements: string[] = [...renamed.statements];
  const refused: string[] = [];
  const changedColumns: { table: string; column: string; changes: string[] }[] = [];
  const drops: string[] = [];
  const alterable: { table: string; column: string; changes: string[] }[] = [];
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
    const alterStatements: string[] = [];
    for (const [column, description] of Object.entries(old.columns)) {
      if (!(column in now.columns)) {
        drops.push(`drop column ${model.name}.${column}`);
        dropColumns.push(`ALTER TABLE ${q(model.name)} DROP COLUMN IF EXISTS ${q(column)}`);
        continue;
      }
      const current = now.columns[column]!;
      const changes = columnChanges(description, current);
      if (!changes.length) continue;
      if (isAlterable(description, current)) {
        alterable.push({ table: model.name, column, changes });
        alterStatements.push(...alterColumnSql(model.name, column, description, current));
      } else {
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
    statements.push(...dropIndexes, ...dropColumns, ...alterStatements);
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      const column = columnName(field);
      if (column in old.columns) continue;
      if (needsValue(schema)) needDefault.push(`${model.name}.${column}`);
      statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN IF NOT EXISTS ${columnDefinition(model, field, schema)}`);
    }
    for (const [name, sql] of Object.entries(now.indexes)) if (!(name in old.indexes)) statements.push(sql);
  }
  // pgvector is enabled before the first table or column that needs it.
  if (needsVectorExtension(statements)) statements.unshift(VECTOR_EXTENSION);
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
    throw new InferloError("IL4013", `inferlo db migrate cannot generate these changes yet: ${explained.join(", ")}.`, {
      fix: "New tables, columns and indexes, drops with --allow-drop, and type, default, required, enum value and reference changes with --allow-change are generated. Renames are generated when you name them with --rename old=new. Index changes are not yet: undo these model changes, or write the SQL yourself in a new migration file.",
      details: { changes: refused, columns: changedColumns },
      expose: true,
    });
  }
  if (drops.length && !options.allowDrop) {
    // A dropped column next to a new column in the same table (or a dropped table next to a new one) is usually a rename.
    const hint = renameHint(before, sorted);
    throw new InferloError("IL4017", `Your model changes drop data: ${drops.join(", ")}.`, {
      fix: `${hint ? `If you renamed it, run inferlo db migrate --rename ${hint} (or pass { renames: { ... } }), which keeps the data. ` : ""}If you mean to delete this data, run inferlo db migrate --allow-drop (or planMigration(models, snapshot, { allowDrop: true })) and review the file. Otherwise restore the removed models, fields or indexes.`,
      details: { drops },
      expose: true,
    });
  }
  const changes = alterable.map((c) => `change column ${c.table}.${c.column} (${c.changes.join(", ")})`);
  if (changes.length && !options.allowChange) {
    throw new InferloError("IL4019", `Your model changes change existing columns: ${changes.join(", ")}.`, {
      fix: "If you mean to change these columns, run inferlo db migrate --allow-change (or planMigration(models, snapshot, { allowChange: true })) and review the file. Changing the type fails if an existing value does not convert. Making a column required fails if rows still have NULL in it, unless the field has a fixed .default(value). Removing an enum value fails if rows still use it. Pointing a reference at another table fails if rows hold ids that table does not have. Otherwise undo the model changes.",
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

/** "notes.color=notes.colour" (or "notes=memos") when a table lost one column and gained one, the likely rename; otherwise undefined. */
function renameHint(before: MigrationSnapshot["tables"], models: readonly AnyModel[]): string | undefined {
  const names = new Set(models.map((m) => m.name));
  for (const model of models) {
    const old = before[model.name];
    if (!old) continue;
    const columns = Object.keys(tableSnapshot(model).columns);
    const removed = Object.keys(old.columns).filter((c) => !columns.includes(c));
    const added = columns.filter((c) => !(c in old.columns));
    if (removed.length === 1 && added.length === 1) return `${model.name}.${removed[0]}=${model.name}.${added[0]}`;
  }
  const removedTables = Object.keys(before).filter((t) => !names.has(t));
  const addedTables = models.map((m) => m.name).filter((t) => !(t in before));
  if (removedTables.length === 1 && addedTables.length === 1) return `${removedTables[0]}=${addedTables[0]}`;
  return undefined;
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
   * (IL4018). They are not run again. Restore the applied SQL and put the change in a new file.
   */
  onEdited?: (names: string[]) => void;
}

/** SHA-256 of the SQL as hex, with Windows line endings normalised so a checkout does not count as an edit. */
async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql.replace(/\r\n/g, "\n")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * IL4020 for a Postgres not-null violation (23502), for example SET NOT NULL on a column that still
 * has NULL rows. Undefined for any other error.
 */
function nullRowsError(error: unknown, migration: string): InferloError | undefined {
  const e = error as { code?: string; table?: string; column?: string; message?: string } | null;
  if (!e || e.code !== "23502") return undefined;
  const match = /column "((?:[^"]|"")+)" of relation "((?:[^"]|"")+)"/.exec(e.message ?? "");
  const table = e.table ?? match?.[2];
  const column = e.column ?? match?.[1];
  const where = table && column ? `${table}.${column}` : "a required column";
  const update = table && column ? `UPDATE ${q(table)} SET ${q(column)} = <value> WHERE ${q(column)} IS NULL` : "UPDATE <table> SET <column> = <value> WHERE <column> IS NULL";
  return new InferloError("IL4020", `Migration ${migration} failed: ${where} is required (NOT NULL) but rows have NULL in it.`, {
    fix: `Fill the NULL rows first: if ${migration} has not been applied anywhere, add ${update}; before the SET NOT NULL statement, or give the field a fixed .default(value) and regenerate the migration. Or keep the field optional.`,
    details: { migration, table, column },
    cause: error,
    expose: true,
  });
}

/**
 * IL4021 for a Postgres check violation (23514), for example adding an enum's CHECK constraint while
 * rows still use a removed value. Undefined for any other error.
 */
function checkViolationError(error: unknown, migration: string): InferloError | undefined {
  const e = error as { code?: string; table?: string; constraint?: string; message?: string } | null;
  if (!e || e.code !== "23514") return undefined;
  const match = /constraint "((?:[^"]|"")+)" of relation "((?:[^"]|"")+)"/.exec(e.message ?? "");
  const table = e.table ?? match?.[2];
  const constraint = e.constraint ?? match?.[1];
  const where = table ? `rows in ${table}` : "rows";
  return new InferloError("IL4021", `Migration ${migration} failed: ${where} have values that ${constraint ? `the check constraint ${constraint}` : "a check constraint"} does not allow, for example an enum value that was removed.`, {
    fix: `Change those rows to an allowed value first: if ${migration} has not been applied anywhere, add UPDATE ${table ? q(table) : "<table>"} SET <column> = '<new value>' WHERE <column> = '<removed value>'; before the ADD CONSTRAINT statement. Or keep the removed enum value in the model.`,
    details: { migration, table, constraint },
    cause: error,
    expose: true,
  });
}

/**
 * IL4031 for a Postgres foreign key violation (23503) while a migration adds a foreign key
 * constraint, for example when a reference now points at another table that does not have every id
 * the rows hold. Undefined for any other error, or when the migration adds no foreign key.
 */
function foreignKeyError(error: unknown, migration: string, sql: string): InferloError | undefined {
  // The Postgres adapter reports a foreign key violation as IL4011, with the driver's error as its cause.
  const original = error instanceof InferloError && error.code === "IL4011" ? error.cause : error;
  const e = original as { code?: string; table?: string; constraint?: string; detail?: string; message?: string } | null;
  if (!e || e.code !== "23503" || !/ADD CONSTRAINT .* FOREIGN KEY /.test(sql)) return undefined;
  const match = /table "((?:[^"]|"")+)" violates foreign key constraint "((?:[^"]|"")+)"/.exec(e.message ?? "");
  const table = e.table ?? match?.[1];
  const constraint = e.constraint ?? match?.[2];
  const where = table ? `rows in ${table}` : "rows";
  return new InferloError("IL4031", `Migration ${migration} failed: ${where} point at ids that the referenced table does not have${constraint ? ` (foreign key ${constraint})` : ""}.`, {
    fix: `Change or clear those references first: if ${migration} has not been applied anywhere, add an UPDATE (for example UPDATE ${table ? q(table) : "<table>"} SET <column> = NULL WHERE <column> NOT IN (SELECT "id" FROM <new table>);) or a DELETE before the ADD CONSTRAINT statement. Or keep the old reference in the model.`,
    details: { migration, table, constraint, reason: e.detail },
    cause: original,
    expose: true,
  });
}

/** SQLSTATEs of a value that does not convert: invalid text, too long, out of range, bad date. */
const CONVERSION_ERRORS = new Set(["22P02", "22001", "22003", "22007", "22008", "22018"]);
const TYPE_CHANGE = new RegExp(`ALTER TABLE (${IDENT}) ALTER COLUMN (${IDENT}) TYPE `, "g");
const unquoteIdent = (s: string) => s.slice(1, -1).replace(/""/g, '"');

/**
 * IL4022 for a value that does not convert, in a migration that changes a column type (ALTER COLUMN
 * ... TYPE). Undefined for any other error, or when the migration changes no column type.
 */
function conversionError(error: unknown, migration: string, sql: string): InferloError | undefined {
  const e = error as { code?: string; message?: string } | null;
  if (!e || !CONVERSION_ERRORS.has(e.code ?? "")) return undefined;
  const columns = [...sql.matchAll(TYPE_CHANGE)].map((m) => `${unquoteIdent(m[1]!)}.${unquoteIdent(m[2]!)}`);
  if (!columns.length) return undefined;
  const reason = e.message ? ` (${e.message})` : "";
  return new InferloError(
    "IL4022",
    `Migration ${migration} failed: an existing value does not convert to the new type of ${columns.length > 1 ? `one of ${columns.join(", ")}` : columns[0]}${reason}.`,
    {
      fix: `Change or clear the values that do not convert first: if ${migration} has not been applied anywhere, add an UPDATE before the ALTER COLUMN ... TYPE statement (for example UPDATE "<table>" SET "<column>" = NULL WHERE ...), or write your own USING expression. Or keep the old field type in the model.`,
      details: { migration, columns, reason: e.message },
      cause: error,
      expose: true,
    },
  );
}

/**
 * Run the migrations that are not yet recorded in the "inferlo_migrations" table, in name order,
 * each in its own transaction. Returns the names it applied. Safe to run from several processes
 * at once (a Postgres advisory lock serialises them).
 *
 * Each applied migration is recorded with a checksum of its SQL. Applied migrations whose SQL has
 * changed since are reported to options.onEdited (IL4018) and are not run again.
 */
export async function applyMigrations(db: SqlDb, migrations: readonly Migration[], options: ApplyMigrationsOptions = {}): Promise<string[]> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!MIGRATION_NAME.test(m.name) || seen.has(m.name)) {
      throw new InferloError("IL4016", `Invalid or duplicate migration name "${m.name}".`, {
        fix: "Migration names use letters, digits, _ and -, and must be unique, e.g. 0002_add_due_dates.",
        expose: true,
      });
    }
    seen.add(m.name);
  }
  // Databases migrated before the rename from Kairo keep their history: rename the old table once.
  const legacy = await db.$sql(
    `SELECT (to_regclass('"kairo_migrations"') IS NOT NULL AND to_regclass('"inferlo_migrations"') IS NULL) AS rename`,
  );
  if (legacy[0]?.rename) await db.$sql(`ALTER TABLE "kairo_migrations" RENAME TO "inferlo_migrations"`);
  await db.$sql(`CREATE TABLE IF NOT EXISTS "inferlo_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now(), "checksum" text)`);
  // Tables created by Inferlo 0.2 have no checksum column. Checked first, because ALTER TABLE locks the table.
  const hasChecksum = await db.$sql(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'inferlo_migrations' AND column_name = 'checksum'`,
  );
  if (!hasChecksum.length) await db.$sql(`ALTER TABLE "inferlo_migrations" ADD COLUMN IF NOT EXISTS "checksum" text`);
  const done = new Map((await db.$sql(`SELECT "name", "checksum" FROM "inferlo_migrations"`)).map((r) => [String(r.name), r.checksum == null ? null : String(r.checksum)]));
  const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sums = new Map(await Promise.all(sorted.map(async (m) => [m.name, await checksum(m.sql)] as const)));
  const edited: string[] = [];
  for (const m of sorted) {
    if (!done.has(m.name)) continue;
    const recorded = done.get(m.name);
    // Applied before checksums were recorded: record the current file.
    if (recorded === null) await db.$sql(`UPDATE "inferlo_migrations" SET "checksum" = $1 WHERE "name" = $2 AND "checksum" IS NULL`, [sums.get(m.name), m.name]);
    else if (recorded !== sums.get(m.name)) edited.push(m.name);
  }
  if (edited.length) options.onEdited?.(edited);
  const applied: string[] = [];
  for (const m of sorted) {
    if (done.has(m.name)) continue;
    const ran = await db.$transaction(async (tx) => {
      await tx.$sql(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      if ((await tx.$sql(`SELECT 1 FROM "inferlo_migrations" WHERE "name" = $1`, [m.name])).length) return false;
      try {
        await tx.$sql(m.sql);
      } catch (error) {
        throw nullRowsError(error, m.name) ?? checkViolationError(error, m.name) ?? conversionError(error, m.name, m.sql) ?? foreignKeyError(error, m.name, m.sql) ?? error;
      }
      await tx.$sql(`INSERT INTO "inferlo_migrations" ("name", "checksum") VALUES ($1, $2)`, [m.name, sums.get(m.name)]);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}
