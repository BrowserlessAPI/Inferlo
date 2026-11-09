/**
 * SQLite adapter on the SQLite built into the runtime (node:sqlite on Node.js and Deno, bun:sqlite on Bun), for
 * small apps, single-server deployments, local tools and fast tests. No packages to install.
 *
 *   import { sqlite } from "@browserlessapi/inferlo/sqlite";
 *   createApp({ db: sqlite({ path: "./data/app.db" }) });     // or sqlite() / sqlite({ path: ":memory:" })
 *
 * Values are stored as SQLite has them: text for strings, ids and dates (ISO 8601 in UTC, which sorts in time
 * order), integers for t.int() and booleans (0 and 1), real numbers, and JSON text for json, array, object and vector
 * fields. Foreign keys are enforced, files use write-ahead logging, and SQLite's single connection is shared by the
 * app: a transaction holds it until it ends, so other queries wait instead of joining the transaction.
 * node:sqlite (bun:sqlite) is loaded with a dynamic import() on first use, so importing Inferlo never needs it.
 */
import { InferloError } from "../errors.ts";
import type { AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import { columnName } from "../model.ts";
import type { Adapter, Condition, DbRecord, Query } from "./types.ts";

export interface SqliteOptions {
  /** The database file, created when missing. Default ":memory:" (a database that lives as long as the process). */
  path?: string;
  /** Milliseconds to wait when another process holds the file's write lock. Default 5000. */
  busyTimeoutMs?: number;
  /** Log every statement with its parameter count. */
  debug?: boolean;
}

/** The part of node:sqlite's DatabaseSync the adapter uses. */
interface Database {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number | bigint } };
  close(): void;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

type Kind = "text" | "integer" | "real" | "boolean" | "date" | "json";

export function kindOf(schema: AnySchema): Kind {
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

export const SQL_TYPE: Record<Kind, string> = { text: "TEXT", integer: "INTEGER", real: "REAL", boolean: "INTEGER", date: "TEXT", json: "TEXT" };

/** A JavaScript value as SQLite stores it. */
function toSqlite(kind: Kind | undefined, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (kind === "json") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  return value;
}

export function literal(kind: Kind, value: unknown): string {
  const v = toSqlite(kind, value);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function columnDefinition(field: string, schema: AnySchema, forAlter = false): string {
  const d = schema.def;
  const kind = kindOf(schema);
  const col = q(columnName(field));
  let sql = `${col} ${SQL_TYPE[kind]}`;
  const fixedDefault = d.hasDefault && typeof d.defaultValue !== "function" ? literal(kind, d.defaultValue) : undefined;
  if (fixedDefault !== undefined) sql += ` DEFAULT ${fixedDefault}`;
  const required = !d.optional && !d.nullable && d.kind !== "any";
  // SQLite adds a NOT NULL column to existing rows only with a fixed default.
  if (required && (!forAlter || fixedDefault !== undefined)) sql += " NOT NULL";
  if (d.kind === "enum" && d.values) sql += ` CHECK (${col} IN (${d.values.map((v) => literal("text", v)).join(", ")}))`;
  if (d.kind === "ref" && d.refTable) sql += ` REFERENCES ${q(d.refTable)}("id") ON DELETE ${(d.onDelete ?? "restrict").toUpperCase()}`;
  return sql;
}

export function createTableSql(model: AnyModel): string {
  const cols = [`"id" TEXT PRIMARY KEY NOT NULL`, `"created_at" TEXT NOT NULL`, `"updated_at" TEXT NOT NULL`];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) cols.push(columnDefinition(field, schema));
  return `CREATE TABLE IF NOT EXISTS ${q(model.name)} (\n  ${cols.join(",\n  ")}\n)`;
}

function indexSql(model: AnyModel): string[] {
  return modelIndexes(model).map(([, sql]) => sql);
}

/** [index name, CREATE INDEX statement] for each unique, indexed and reference field. */
export function modelIndexes(model: AnyModel): [string, string][] {
  const out: [string, string][] = [];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
    const col = columnName(field);
    if (schema.def.unique) {
      const cols = model.tenant ? `${q("tenant_id")}, ${q(col)}` : q(col);
      out.push([`${model.name}_${col}_key`, `CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${model.name}_${col}_key`)} ON ${q(model.name)} (${cols})`]);
    } else if ((schema.def.index || schema.def.kind === "ref") && schema.def.kind !== "vector") {
      out.push([`${model.name}_${col}_idx`, `CREATE INDEX IF NOT EXISTS ${q(`${model.name}_${col}_idx`)} ON ${q(model.name)} (${q(col)})`]);
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

/** A LIKE pattern (% and _, backslash escapes) as a case-sensitive GLOB pattern. SQLite's LIKE ignores ASCII case. */
export function likeToGlob(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      const next = pattern[++i]!;
      out += next === "*" || next === "?" || next === "[" ? `[${next}]` : next;
    } else if (c === "%") out += "*";
    else if (c === "_") out += "?";
    else if (c === "*" || c === "?" || c === "[") out += `[${c}]`;
    else out += c;
  }
  return out;
}

function translate(error: unknown): unknown {
  const e = error as { message?: string; errcode?: number; code?: string };
  const message = typeof e?.message === "string" ? e.message : "";
  if (/UNIQUE constraint failed/.test(message)) {
    const columns = /UNIQUE constraint failed: (.*)$/.exec(message)?.[1];
    return new InferloError("IL4004", "A row with this value already exists.", { status: 409, details: { columns }, cause: error });
  }
  if (/FOREIGN KEY constraint failed/.test(message)) {
    return new InferloError("IL4011", "This references a row that does not exist (or is still referenced elsewhere).", { status: 409, cause: error });
  }
  if (/no such table/.test(message)) {
    return new InferloError("IL4012", `Table missing: ${message}`, { fix: "Run: inferlo db push", cause: error });
  }
  return error;
}

/** One statement at a time per database, and a transaction keeps the database until it ends. */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function sqlite(options: SqliteOptions = {}): Adapter {
  if (!options || typeof options !== "object") throw invalid("sqlite() takes { path }.");
  const unknownKey = Object.keys(options).find((k) => !["path", "busyTimeoutMs", "debug"].includes(k));
  if (unknownKey) throw invalid(`sqlite() has the unknown option ${unknownKey}.`);
  const path = options.path ?? ":memory:";
  if (typeof path !== "string" || !path) throw invalid("sqlite({ path }) must be a file path or \":memory:\".");
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw invalid("sqlite({ busyTimeoutMs }) must be a whole number of milliseconds.");
  const debug = options.debug ?? false;

  let database: Promise<Database> | undefined;
  const open = (): Promise<Database> =>
    (database ??= (async () => {
      let Sqlite: new (path: string) => Database;
      try {
        // Bun's own bun:sqlite on Bun (node:sqlite only arrived in later Bun releases), node:sqlite elsewhere.
        Sqlite =
          typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
            ? ((await import("bun:sqlite" as string)) as { Database: new (path: string) => Database }).Database
            : ((await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
      } catch (cause) {
        database = undefined;
        throw new InferloError("IL4034", "This runtime has no built-in SQLite (node:sqlite).", {
          fix: "Use Node.js 22.13 or later, Bun 1.3 or later or Deno 2.2 or later, or postgres() from @browserlessapi/inferlo/postgres.",
          cause,
        });
      }
      const db = new Sqlite(path);
      db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
      if (path !== ":memory:" && !path.startsWith("file::memory:")) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      return db;
    })());
  const lock = new Lock();
  let models = new Map<string, AnyModel>();

  const adapter = createSqliteAdapter(open, lock, () => models, (m) => (models = m), debug, false);
  adapter.close = async () => {
    if (!database) return;
    const db = await database.catch(() => undefined);
    database = undefined;
    await lock.run(() => db?.close());
  };
  return adapter;
}

function invalid(message: string): InferloError {
  return new InferloError("IL4033", message, { fix: 'Use sqlite({ path: "./data/app.db" }), or sqlite() for a database in memory.' });
}

function createSqliteAdapter(
  open: () => Promise<Database>,
  lock: Lock,
  getModels: () => Map<string, AnyModel>,
  setModels: (m: Map<string, AnyModel>) => void,
  debug: boolean,
  inTransaction: boolean,
): Adapter {
  // Inside a transaction the lock is already held, so statements run directly.
  const locked = <T>(fn: (db: Database) => T): Promise<T> => (inTransaction ? open().then(fn) : open().then((db) => lock.run(() => fn(db))));

  const all = (text: string, params: unknown[] = []): Promise<DbRecord[]> =>
    locked((db) => {
      if (debug) console.log(`[inferlo:sql] ${text.replace(/\s+/g, " ")} (${params.length} params)`);
      try {
        return db.prepare(text).all(...params) as DbRecord[];
      } catch (error) {
        throw translate(error);
      }
    });
  const run = (text: string, params: unknown[] = []): Promise<number> =>
    locked((db) => {
      if (debug) console.log(`[inferlo:sql] ${text.replace(/\s+/g, " ")} (${params.length} params)`);
      try {
        return Number(db.prepare(text).run(...params).changes);
      } catch (error) {
        throw translate(error);
      }
    });

  const fieldKind = (model: AnyModel, field: string): Kind | undefined => {
    const schema = (model.fields as Record<string, AnySchema>)[field];
    if (schema) return kindOf(schema);
    return field === "createdAt" || field === "updatedAt" ? "date" : undefined;
  };

  const fromDb = (model: AnyModel, row: DbRecord): DbRecord => {
    const out: DbRecord = { id: row.id, createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)) };
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      let value = row[columnName(field)];
      if (value !== null && value !== undefined) {
        const kind = kindOf(schema);
        if (kind === "date") value = new Date(String(value));
        else if (kind === "boolean") value = value === 1 || value === 1n || value === true;
        else if (kind === "json") value = JSON.parse(String(value));
        else if (typeof value === "bigint") value = Number(value);
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
        params.push(toSqlite(kind, v));
        return "?";
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
          if (!(value as unknown[]).length) return "0";
          return `${col} IN (${list(value as unknown[])})`;
        case "notIn":
          if (!(value as unknown[]).length) return `${col} IS NOT NULL`;
          return `${col} NOT IN (${list(value as unknown[])})`;
        case "like":
          params.push(likeToGlob(String(value)));
          return `${col} GLOB ?`;
        case "ilike":
          return `${col} LIKE ${p(value)} ESCAPE '\\'`;
        case "isNull":
          return value ? `${col} IS NULL` : `${col} IS NOT NULL`;
      }
    });
    return ` WHERE ${parts.join(" AND ")}`;
  };

  const adapter: Adapter = {
    dialect: "sqlite",
    connect(models) {
      setModels(new Map(models.map((m) => [m.name, m])));
    },
    async insert(model, row) {
      const fields = Object.keys(row);
      const params = fields.map((f) => toSqlite(fieldKind(model, f), row[f]));
      const sql = `INSERT INTO ${q(model.name)} (${fields.map((f) => q(columnName(f))).join(", ")}) VALUES (${fields.map(() => "?").join(", ")}) RETURNING *`;
      return fromDb(model, (await all(sql, params))[0]!);
    },
    async select(model, query: Query) {
      const params: unknown[] = [];
      let sql = `SELECT * FROM ${q(model.name)}${whereSql(model, query.where, params)}`;
      if (query.orderBy.length) sql += ` ORDER BY ${query.orderBy.map(([f, d]) => `${q(columnName(f))} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
      if (query.limit !== undefined) sql += ` LIMIT ${Number(query.limit)}`;
      else if (query.offset) sql += " LIMIT -1";
      if (query.offset) sql += ` OFFSET ${Number(query.offset)}`;
      return (await all(sql, params)).map((r) => fromDb(model, r));
    },
    async update(model, where, patch) {
      const params: unknown[] = [];
      const sets = Object.keys(patch).map((f) => {
        params.push(toSqlite(fieldKind(model, f), patch[f]));
        return `${q(columnName(f))} = ?`;
      });
      const sql = `UPDATE ${q(model.name)} SET ${sets.join(", ")}${whereSql(model, where, params)} RETURNING *`;
      return (await all(sql, params)).map((r) => fromDb(model, r));
    },
    async delete(model, where) {
      const params: unknown[] = [];
      return run(`DELETE FROM ${q(model.name)}${whereSql(model, where, params)}`, params);
    },
    async count(model, where) {
      const params: unknown[] = [];
      const rows = await all(`SELECT count(*) AS n FROM ${q(model.name)}${whereSql(model, where, params)}`, params);
      return Number(rows[0]?.n ?? 0);
    },
    async search(model, query) {
      // SQLite has no vector index: rows are compared in JavaScript, which suits the small tables SQLite apps have.
      const params: unknown[] = [];
      const where = whereSql(model, [...query.where, { field: query.field, op: "isNull", value: false }], params);
      const rows = (await all(`SELECT * FROM ${q(model.name)}${where}`, params)).map((r) => fromDb(model, r));
      const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      const qn = norm(query.vector);
      return rows
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
        const columns = new Set((await all(`PRAGMA table_info(${q(model.name)})`)).map((r) => String(r.name)));
        if (!columns.size) {
          statements.push(createTableSql(model), ...indexSql(model));
          continue;
        }
        for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
          if (!columns.has(columnName(field))) statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN ${columnDefinition(field, schema, true)}`);
        }
        statements.push(...indexSql(model));
      }
      if (!options.dryRun) for (const s of statements) await run(s);
      return statements;
    },
    async sql(text, params = []) {
      return all(text, params.map((p) => toSqlite(undefined, p)));
    },
    async transaction(fn) {
      if (inTransaction) return fn(adapter);
      const db = await open();
      return lock.run(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(createSqliteAdapter(open, lock, getModels, () => {}, debug, true));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // SQLite already rolled back
          }
          throw error;
        }
      });
    },
  };
  return adapter;
}
