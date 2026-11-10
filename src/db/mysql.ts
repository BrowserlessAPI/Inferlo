/**
 * MySQL adapter, on the mysql2 driver (an optional peer dependency).
 *
 *   import { mysql } from "@browserlessapi/inferlo/mysql";
 *   createApp({ db: mysql({ url: settings.DATABASE_URL }) });   // mysql://user:pass@host:3306/app
 *   createApp({ db: mysql({ pool }) });                          // a mysql2/promise pool the app already has
 *
 * Tables Inferlo creates use utf8mb4 with the binary collation utf8mb4_bin, so comparisons, unique values and
 * `like` are case-sensitive, as on Postgres. Dates are DATETIME(3) in UTC, JSON fields use MySQL's JSON type, and
 * booleans are BOOLEAN. MySQL has no RETURNING, so insert and update read the rows back by id.
 */
import { InferloError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import type { Adapter, Condition, DbRecord, Query } from "./types.ts";

/** The part of a mysql2/promise connection the adapter uses. */
export interface MysqlQueryable {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}
export interface MysqlConnection extends MysqlQueryable {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}
export interface MysqlPool extends MysqlQueryable {
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

export interface MysqlOptions {
  /** mysql://user:pass@host:3306/database */
  url?: string;
  /** Bring your own mysql2/promise pool. Create it with timezone: "Z" so dates are read as UTC. */
  pool?: MysqlPool;
  /** Maximum pool size (default 10). */
  max?: number;
  /** Log every statement with its parameter count. */
  debug?: boolean;
}

const q = (identifier: string) => `\`${identifier.replace(/`/g, "``")}\``;

type Kind = "text" | "integer" | "real" | "boolean" | "date" | "json";

function kindOf(schema: AnySchema): Kind {
  switch (schema.def.kind) {
    case "int":
      return "integer";
    case "number":
      return "real";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "json":
    case "array":
    case "object":
    case "any":
    case "vector":
      return "json";
    case "file":
      throw new InferloError("IL1004", "t.file() fields cannot be stored in a database column.", { fix: "Store the file elsewhere and keep its key or URL in a t.string() field." });
    default:
      return "text";
  }
}

/** The MySQL column type. Strings that are unique or indexed need a length: their .max(), else VARCHAR(255). */
export function columnType(schema: AnySchema): string {
  const d = schema.def;
  switch (d.kind) {
    case "uuid":
    case "ref":
      return "CHAR(36)";
    case "string":
      return d.max !== undefined && d.max <= 16383 ? `VARCHAR(${d.max})` : d.unique || d.index ? "VARCHAR(255)" : "TEXT";
    case "email":
      return "VARCHAR(320)";
    case "url":
      return d.unique || d.index ? "VARCHAR(255)" : "TEXT";
    case "enum":
    case "literal":
      return "VARCHAR(255)";
    case "text":
      return "MEDIUMTEXT";
    case "int":
      return "INT";
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATETIME(3)";
    default:
      kindOf(schema);
      return "JSON";
  }
}

/** A JavaScript value as MySQL takes it. */
function toMysql(kind: Kind | undefined, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (kind === "json") return JSON.stringify(value);
  if (value instanceof Date) return value;
  if (typeof value === "bigint") return Number(value);
  return value;
}

function literal(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(typeof value === "object" ? JSON.stringify(value) : value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** The DEFAULT of a field with a fixed default, as MySQL takes it: a literal, or an expression in parentheses for JSON and TEXT columns. */
export function defaultSql(schema: AnySchema): string | undefined {
  const d = schema.def;
  if (!d.hasDefault || typeof d.defaultValue === "function") return undefined;
  const fixed = d.defaultValue;
  const type = columnType(schema);
  if (type === "JSON") return `(CAST(${literal(JSON.stringify(fixed))} AS JSON))`;
  if (/TEXT$/.test(type)) return `(${literal(fixed)})`;
  return fixed instanceof Date ? literal(fixed.toISOString().slice(0, 23).replace("T", " ")) : literal(fixed);
}

export function columnDefinition(field: string, schema: AnySchema, forAlter = false): string {
  const d = schema.def;
  const col = q(columnName(field));
  const type = columnType(schema);
  let sql = `${col} ${type}`;
  const fixed = d.hasDefault && typeof d.defaultValue !== "function" ? d.defaultValue : undefined;
  const fixedDefault = defaultSql(schema);
  if (fixedDefault !== undefined) sql += ` DEFAULT ${fixedDefault}`;
  const required = !d.optional && !d.nullable && d.kind !== "any";
  if (required && (!forAlter || fixed !== undefined)) sql += " NOT NULL";
  if (d.kind === "enum" && d.values) sql += ` CHECK (${col} IN (${d.values.map(literal).join(", ")}))`;
  return sql;
}

/** The FOREIGN KEY constraint of a t.ref field, as in CREATE TABLE and ALTER TABLE ... ADD. */
export function foreignKeySql(table: string, field: string, schema: AnySchema): string {
  const col = columnName(field);
  return `CONSTRAINT ${q(constraintName(`${table}_${col}_fkey`))} FOREIGN KEY (${q(col)}) REFERENCES ${q(schema.def.refTable!)} (\`id\`) ON DELETE ${(schema.def.onDelete ?? "restrict").toUpperCase()}`;
}

function foreignKeys(model: AnyModel): string[] {
  const out: string[] = [];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
    if (schema.def.kind === "ref" && schema.def.refTable) out.push(foreignKeySql(model.name, field, schema));
  }
  return out;
}

/** MySQL names are at most 64 characters. */
export function constraintName(name: string): string {
  if (name.length <= 64) return name;
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `${name.slice(0, 55)}_${hash.toString(16).padStart(8, "0")}`;
}

export function createTableSql(model: AnyModel): string {
  const cols = ["`id` CHAR(36) NOT NULL PRIMARY KEY", "`created_at` DATETIME(3) NOT NULL", "`updated_at` DATETIME(3) NOT NULL"];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) cols.push(columnDefinition(field, schema));
  cols.push(...foreignKeys(model));
  return `CREATE TABLE IF NOT EXISTS ${q(model.name)} (\n  ${cols.join(",\n  ")}\n) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`;
}

/** [index name, CREATE INDEX statement]. MySQL indexes foreign key columns itself. */
export function modelIndexes(model: AnyModel): [string, string][] {
  const out: [string, string][] = [];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
    const col = columnName(field);
    if (schema.def.unique) {
      const name = constraintName(`${model.name}_${col}_key`);
      const cols = model.tenant ? `${q("tenant_id")}, ${q(col)}` : q(col);
      out.push([name, `CREATE UNIQUE INDEX ${q(name)} ON ${q(model.name)} (${cols})`]);
    } else if (schema.def.index && schema.def.kind !== "vector" && schema.def.kind !== "ref") {
      const name = constraintName(`${model.name}_${col}_idx`);
      out.push([name, `CREATE INDEX ${q(name)} ON ${q(model.name)} (${q(col)})`]);
    }
  }
  return out;
}

export function sortByReferences(models: AnyModel[]): AnyModel[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const out: AnyModel[] = [];
  const seen = new Set<string>();
  const visit = (m: AnyModel, stack: Set<string>) => {
    if (seen.has(m.name) || stack.has(m.name)) return;
    stack.add(m.name);
    for (const schema of Object.values(m.fields as Record<string, AnySchema>)) {
      const ref = schema.def.refTable;
      if (ref && ref !== m.name && byName.has(ref)) visit(byName.get(ref)!, stack);
    }
    seen.add(m.name);
    out.push(m);
  };
  for (const m of models) visit(m, new Set());
  return out;
}

function translate(error: unknown): unknown {
  const e = error as { errno?: number; code?: string; message?: string; sqlMessage?: string };
  if (e?.errno === 1062) return new InferloError("IL4004", "A row with this value already exists.", { status: 409, cause: error });
  if (e?.errno === 1451 || e?.errno === 1452) {
    return new InferloError("IL4011", "This references a row that does not exist (or is still referenced elsewhere).", { status: 409, cause: error });
  }
  if (e?.errno === 1146) return new InferloError("IL4012", `Table missing: ${e.sqlMessage ?? e.message}`, { fix: "Run: inferlo db push", cause: error });
  return error;
}

function invalid(message: string): InferloError {
  return new InferloError("IL4036", message, { fix: "Use mysql({ url: settings.DATABASE_URL }) with mysql://user:pass@host:3306/app, or mysql({ pool }) with a mysql2/promise pool." });
}

export function mysql(options: MysqlOptions = {}): Adapter {
  if (!options || typeof options !== "object") throw invalid("mysql() takes { url } or { pool }.");
  const unknownKey = Object.keys(options).find((k) => !["url", "pool", "max", "debug"].includes(k));
  if (unknownKey) throw invalid(`mysql() has the unknown option ${unknownKey}.`);
  if (options.url !== undefined && options.pool !== undefined) throw invalid("mysql() takes url or pool, not both.");
  if (options.url !== undefined && (typeof options.url !== "string" || !/^mysql:\/\//.test(options.url))) throw invalid("mysql({ url }) must start with mysql://.");
  if (options.pool !== undefined && (typeof options.pool !== "object" || typeof options.pool.query !== "function" || typeof options.pool.getConnection !== "function")) throw invalid("mysql({ pool }) must be a mysql2/promise pool.");
  if (options.max !== undefined && (!Number.isInteger(options.max) || options.max < 1)) throw invalid("mysql({ max }) must be a positive whole number.");
  let pool: MysqlPool | undefined = options.pool;
  let ownPool: Promise<MysqlPool> | undefined;

  const getPool = async (): Promise<MysqlPool> => {
    if (pool) return pool;
    if (!options.url) {
      throw new InferloError("IL4009", "mysql() needs a connection URL.", { fix: 'Pass mysql({ url: settings.DATABASE_URL }) with DATABASE_URL=mysql://user:pass@localhost:3306/app.' });
    }
    return (ownPool ??= (async () => {
      let driver: { createPool(o: object): MysqlPool; default?: { createPool(o: object): MysqlPool } };
      try {
        driver = (await import("mysql2/promise" as string)) as typeof driver;
      } catch (cause) {
        ownPool = undefined;
        throw new InferloError("IL4010", "The mysql2 package is not installed.", { fix: "Run: npm install mysql2", cause });
      }
      const createPool = driver.createPool ?? driver.default!.createPool;
      // timezone "Z": DATETIME values are UTC both ways. supportBigNumbers keeps large counts exact.
      pool = createPool({ uri: options.url, connectionLimit: options.max ?? 10, timezone: "Z", supportBigNumbers: true, dateStrings: false });
      return pool;
    })());
  };

  const adapter = createMysqlAdapter(getPool, options.debug ?? false, false);
  adapter.close = async () => {
    if (pool && !options.pool) await pool.end();
    pool = options.pool;
    ownPool = undefined;
  };
  return adapter;
}

function createMysqlAdapter(client: () => Promise<MysqlQueryable>, debug: boolean, inTransaction: boolean): Adapter {
  const run = async (text: string, params: unknown[] = []): Promise<unknown> => {
    if (debug) console.log(`[inferlo:sql] ${text.replace(/\s+/g, " ")} (${params.length} params)`);
    try {
      const [result] = await (await client()).query(text, params);
      return result;
    } catch (error) {
      throw translate(error);
    }
  };
  const rows = async (text: string, params: unknown[] = []) => (await run(text, params)) as DbRecord[];

  const fieldKind = (model: AnyModel, field: string): Kind | undefined => {
    const schema = (model.fields as Record<string, AnySchema>)[field];
    if (schema) return kindOf(schema);
    return field === "createdAt" || field === "updatedAt" ? "date" : undefined;
  };

  const fromDb = (model: AnyModel, row: DbRecord): DbRecord => {
    const out: DbRecord = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      let value = row[columnName(field)];
      if (value !== null && value !== undefined) {
        const kind = kindOf(schema);
        if (kind === "boolean") value = value === 1 || value === true || value === "1";
        else if (kind === "json" && typeof value === "string") value = JSON.parse(value);
        else if (kind === "integer" || kind === "real") value = Number(value);
        else if (kind === "date" && !(value instanceof Date)) value = new Date(String(value));
      }
      out[field] = value ?? null;
    }
    return out;
  };

  const whereSql = (model: AnyModel, conditions: Condition[], params: unknown[]): string => {
    if (!conditions.length) return "";
    const parts = conditions.map(({ field, op, value }) => {
      const col = q(columnName(field));
      const kind = fieldKind(model, field);
      const p = (v: unknown) => {
        params.push(toMysql(kind, v));
        return kind === "json" ? "CAST(? AS JSON)" : "?";
      };
      const list = (values: unknown[]) => values.map(p).join(", ");
      switch (op) {
        case "eq":
          return `${col} = ${p(value)}`;
        case "ne":
          return `${col} <> ${p(value)}`;
        case "gt":
          return `${col} > ${p(value)}`;
        case "gte":
          return `${col} >= ${p(value)}`;
        case "lt":
          return `${col} < ${p(value)}`;
        case "lte":
          return `${col} <= ${p(value)}`;
        case "in":
          if (!(value as unknown[]).length) return "FALSE";
          return `${col} IN (${list(value as unknown[])})`;
        case "notIn":
          if (!(value as unknown[]).length) return `${col} IS NOT NULL`;
          return `${col} NOT IN (${list(value as unknown[])})`;
        case "like":
          params.push(value);
          return `${col} LIKE ? COLLATE utf8mb4_bin`;
        case "ilike":
          params.push(value);
          return `LOWER(${col}) LIKE LOWER(?)`;
        case "isNull":
          return value ? `${col} IS NULL` : `${col} IS NOT NULL`;
      }
    });
    return ` WHERE ${parts.join(" AND ")}`;
  };

  const byIds = async (model: AnyModel, ids: unknown[]): Promise<DbRecord[]> => {
    if (!ids.length) return [];
    const found = await rows(`SELECT * FROM ${q(model.name)} WHERE \`id\` IN (${ids.map(() => "?").join(", ")})`, ids);
    const order = new Map(ids.map((id, i) => [id, i]));
    return found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((r) => fromDb(model, r));
  };

  const adapter: Adapter = {
    dialect: "mysql",
    async insert(model, row) {
      const fields = Object.keys(row);
      const params = fields.map((f) => toMysql(fieldKind(model, f), row[f]));
      await run(`INSERT INTO ${q(model.name)} (${fields.map((f) => q(columnName(f))).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, params);
      const [inserted] = await byIds(model, [row.id]);
      return inserted!;
    },
    async select(model, query: Query) {
      const params: unknown[] = [];
      let sql = `SELECT * FROM ${q(model.name)}${whereSql(model, query.where, params)}`;
      if (query.orderBy.length) sql += ` ORDER BY ${query.orderBy.map(([f, d]) => `${q(columnName(f))} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
      if (query.limit !== undefined) sql += ` LIMIT ${Number(query.limit)}`;
      else if (query.offset) sql += " LIMIT 18446744073709551615";
      if (query.offset) sql += ` OFFSET ${Number(query.offset)}`;
      return (await rows(sql, params)).map((r) => fromDb(model, r));
    },
    async update(model, where, patch) {
      // No RETURNING: the ids are read first, then the rows are updated by id and read back, in one transaction.
      return adapter.transaction!(async (tx) => {
        const txRows = (tx as unknown as { rows: typeof rows }).rows;
        const params: unknown[] = [];
        const ids = (await txRows(`SELECT \`id\` FROM ${q(model.name)}${whereSql(model, where, params)} FOR UPDATE`, params)).map((r) => r.id);
        if (!ids.length) return [];
        const setParams: unknown[] = [];
        const sets = Object.keys(patch).map((f) => {
          setParams.push(toMysql(fieldKind(model, f), patch[f]));
          return `${q(columnName(f))} = ${fieldKind(model, f) === "json" ? "CAST(? AS JSON)" : "?"}`;
        });
        await txRows(`UPDATE ${q(model.name)} SET ${sets.join(", ")} WHERE \`id\` IN (${ids.map(() => "?").join(", ")})`, [...setParams, ...ids]);
        return (tx as unknown as { byIds: typeof byIds }).byIds(model, ids);
      });
    },
    async delete(model, where) {
      const params: unknown[] = [];
      const result = (await run(`DELETE FROM ${q(model.name)}${whereSql(model, where, params)}`, params)) as { affectedRows?: number };
      return Number(result.affectedRows ?? 0);
    },
    async count(model, where) {
      const params: unknown[] = [];
      const result = await rows(`SELECT COUNT(*) AS n FROM ${q(model.name)}${whereSql(model, where, params)}`, params);
      return Number(result[0]?.n ?? 0);
    },
    async search(model, query) {
      // Vectors are JSON arrays, compared in JavaScript (MySQL Community has no vector distance function).
      const params: unknown[] = [];
      const where = whereSql(model, [...query.where, { field: query.field, op: "isNull", value: false }], params);
      const found = (await rows(`SELECT * FROM ${q(model.name)}${where}`, params)).map((r) => fromDb(model, r));
      const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      const qn = norm(query.vector);
      return found
        .map((row) => {
          const v = row[query.field] as number[];
          const denominator = qn * norm(v);
          const dot = v.reduce((s, x, i) => s + x * (query.vector[i] ?? 0), 0);
          return { row, distance: denominator === 0 ? 1 : 1 - dot / denominator };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, query.limit);
    },
    async sync(models, options = {}) {
      const statements: string[] = [];
      for (const model of sortByReferences(models)) {
        const columns = new Set((await rows("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [model.name])).map((r) => String(r.name)));
        const indexes = new Set((await rows("SELECT DISTINCT INDEX_NAME AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?", [model.name])).map((r) => String(r.name)));
        if (!columns.size) statements.push(createTableSql(model));
        else {
          for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
            if (!columns.has(columnName(field))) statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN ${columnDefinition(field, schema, true)}`);
          }
        }
        for (const [name, sql] of modelIndexes(model)) if (!indexes.has(name)) statements.push(sql);
      }
      if (!options.dryRun) for (const s of statements) await run(s);
      return statements;
    },
    async sql(text, params = []) {
      const result = await run(text, params);
      return Array.isArray(result) ? (result as DbRecord[]) : [];
    },
    async transaction(fn, options) {
      if (inTransaction) return fn(adapter);
      const pool = (await client()) as MysqlPool;
      const conn = await pool.getConnection();
      try {
        // SET TRANSACTION (without SESSION) applies to the next transaction only, so the pooled connection keeps its default.
        if (options?.isolation === "read committed") await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await conn.beginTransaction();
        const tx = createMysqlAdapter(async () => conn, debug, true);
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    },
  };
  Object.assign(adapter, { rows, byIds });
  return adapter;
}
