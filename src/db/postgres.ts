/**
 * PostgreSQL adapter (uses the `pg` package: npm install pg).
 *
 *   import { postgres } from "@browserlessapi/inferlo/postgres"
 *   createApp({ db: postgres({ url: env("DATABASE_URL") }), ... })
 *
 * Every value is sent as a query parameter. Identifiers come only from model definitions,
 * which are validated, and are always quoted.
 */
import { InferloError } from "../errors.ts";
import { columnName, type AnyModel } from "../model.ts";
import type { AnySchema } from "../schema.ts";
import type { Adapter, Condition, DbRecord, Query } from "./types.ts";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: DbRecord[]; rowCount: number | null }>;
}
interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end(): Promise<void>;
}

export interface PostgresOptions {
  /** postgres://user:pass@host:5432/db */
  url?: string;
  /** Bring your own pg.Pool. */
  pool?: PoolLike;
  /** Maximum pool size (default 10). */
  max?: number;
  /** Log every statement with its parameter count. */
  debug?: boolean;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export function columnType(schema: AnySchema): string {
  const d = schema.def;
  switch (d.kind) {
    case "string":
      return d.max !== undefined && d.max <= 10485760 ? `varchar(${d.max})` : "text";
    case "text":
    case "email":
    case "url":
    case "enum":
    case "literal":
      return "text";
    case "uuid":
    case "ref":
      return "uuid";
    case "number":
      return "double precision";
    case "int":
      return "integer";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamptz";
    case "json":
    case "array":
    case "object":
    case "any":
      return "jsonb";
    case "vector":
      return `vector(${d.dimensions})`;
    case "file":
      // model() rejects t.file() fields, so this is only reached by a hand-built schema.
      throw new InferloError("IL1004", "t.file() fields cannot be stored in a database column.", { fix: "Store the file elsewhere and keep its key or URL in a t.string() field." });
  }
}

function isJson(schema: AnySchema): boolean {
  return columnType(schema) === "jsonb";
}

function isVector(schema: AnySchema): boolean {
  return schema.def.kind === "vector";
}

/** The statement that enables pgvector, for models with t.vector() fields. */
export const VECTOR_EXTENSION = "CREATE EXTENSION IF NOT EXISTS vector";

/** True when a statement creates a vector column, so pgvector must be enabled first. */
export function needsVectorExtension(statements: readonly string[]): boolean {
  return statements.some((s) => /^(CREATE TABLE|ALTER TABLE)\b[\s\S]* vector\(\d+\)/.test(s));
}

function literal(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(typeof value === "object" ? JSON.stringify(value) : value).replace(/'/g, "''")}'`;
}

/** The column's SQL DEFAULT expression, or undefined when it has no fixed default (function defaults run in JavaScript). */
export function defaultSql(schema: AnySchema): string | undefined {
  const d = schema.def;
  if (!d.hasDefault || typeof d.defaultValue === "function") return undefined;
  return `${literal(d.defaultValue)}${isJson(schema) ? "::jsonb" : ""}`;
}

export function columnDefinition(model: AnyModel, field: string, schema: AnySchema, forAlter = false): string {
  const d = schema.def;
  let sql = `${q(columnName(field))} ${columnType(schema)}`;
  const fixedDefault = defaultSql(schema);
  if (fixedDefault !== undefined) sql += ` DEFAULT ${fixedDefault}`;
  const required = !d.optional && !d.nullable && !(d.kind === "any");
  if (required && (!forAlter || (d.hasDefault && typeof d.defaultValue !== "function"))) sql += " NOT NULL";
  if (d.kind === "enum" && d.values) sql += ` CHECK (${q(columnName(field))} IN (${d.values.map(literal).join(", ")}))`;
  if (d.kind === "ref" && d.refTable) {
    sql += ` REFERENCES ${q(d.refTable)}("id") ON DELETE ${(d.onDelete ?? "restrict").toUpperCase()}`;
  }
  void model;
  return sql;
}

export const SYSTEM_COLUMNS: [column: string, definition: string][] = [
  ["id", `"id" uuid PRIMARY KEY`],
  ["created_at", `"created_at" timestamptz NOT NULL DEFAULT now()`],
  ["updated_at", `"updated_at" timestamptz NOT NULL DEFAULT now()`],
];

export function createTableSql(model: AnyModel): string[] {
  const cols = SYSTEM_COLUMNS.map(([, definition]) => definition);
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) cols.push(columnDefinition(model, field, schema));
  return [`CREATE TABLE IF NOT EXISTS ${q(model.name)} (\n  ${cols.join(",\n  ")}\n)`, ...indexSql(model)];
}

function indexSql(model: AnyModel): string[] {
  return modelIndexes(model).map(([, sql]) => sql);
}

/** [index name, CREATE INDEX statement] for every unique, indexed or ref field. */
export function modelIndexes(model: AnyModel): [name: string, sql: string][] {
  const out: [string, string][] = [];
  for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
    const col = columnName(field);
    if (schema.def.unique) {
      // Unique per tenant on tenant-scoped models: two tenants may both have the slug "support".
      const name = `${model.name}_${col}_key`;
      const cols = model.tenant ? `${q("tenant_id")}, ${q(col)}` : q(col);
      out.push([name, `CREATE UNIQUE INDEX IF NOT EXISTS ${q(name)} ON ${q(model.name)} (${cols})`]);
    } else if (schema.def.index && isVector(schema)) {
      // HNSW index for cosine distance, the distance db.<table>.search() orders by (pgvector 0.5.0 and later).
      const name = `${model.name}_${col}_idx`;
      out.push([name, `CREATE INDEX IF NOT EXISTS ${q(name)} ON ${q(model.name)} USING hnsw (${q(col)} vector_cosine_ops)`]);
    } else if (schema.def.index || schema.def.kind === "ref") {
      const name = `${model.name}_${col}_idx`;
      out.push([name, `CREATE INDEX IF NOT EXISTS ${q(name)} ON ${q(model.name)} (${q(col)})`]);
    }
  }
  return out;
}

/** Order models so referenced tables are created first. */
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

export function postgres(options: PostgresOptions = {}): Adapter {
  let pool: PoolLike | undefined = options.pool;
  let models = new Map<string, AnyModel>();

  const getPool = async (): Promise<PoolLike> => {
    if (pool) return pool;
    if (!options.url) {
      throw new InferloError("IL4009", "postgres() needs a connection URL.", {
        fix: 'Pass postgres({ url: env("DATABASE_URL") }) and set DATABASE_URL, e.g. postgres://user:pass@localhost:5432/app',
      });
    }
    let pg: { default?: { Pool: new (o: object) => PoolLike }; Pool?: new (o: object) => PoolLike };
    try {
      pg = (await import("pg" as string)) as typeof pg;
    } catch (cause) {
      throw new InferloError("IL4010", "The pg package is not installed.", { fix: "Run: npm install pg", cause });
    }
    const Pool = pg.Pool ?? pg.default!.Pool;
    pool = new Pool({ connectionString: options.url, max: options.max ?? 10 });
    return pool;
  };

  return createPgAdapter(async () => getPool(), () => models, (m) => (models = m), options.debug ?? false, async () => {
    if (pool && !options.pool) await pool.end();
    pool = undefined;
  });
}

function createPgAdapter(
  client: () => Promise<Queryable | PoolLike>,
  getModels: () => Map<string, AnyModel>,
  setModels: (m: Map<string, AnyModel>) => void,
  debug: boolean,
  close: () => Promise<void>,
): Adapter {
  const run = async (text: string, params: unknown[] = []) => {
    if (debug) console.log(`[inferlo:sql] ${text.replace(/\s+/g, " ")} (${params.length} params)`);
    try {
      return await (await client()).query(text, params);
    } catch (error) {
      throw translate(error);
    }
  };

  const fieldSchema = (model: AnyModel, field: string): AnySchema | undefined => (model.fields as Record<string, AnySchema>)[field];

  const toDb = (model: AnyModel, field: string, value: unknown): unknown => {
    const schema = fieldSchema(model, field);
    if (schema && (isJson(schema) || isVector(schema)) && value !== null && value !== undefined) return JSON.stringify(value);
    return value;
  };

  // JSON values are sent as text and cast on the server, so drivers that pick a parameter's encoding from the
  // column's type (postgres.js through postgresJsPool) do not encode the JSON text a second time.
  const placeholder = (model: AnyModel, field: string, index: number): string => {
    const schema = fieldSchema(model, field);
    if (schema && isVector(schema)) return `$${index}::text::vector`;
    return schema && isJson(schema) ? `$${index}::text::jsonb` : `$${index}`;
  };

  const fromDb = (model: AnyModel, row: DbRecord): DbRecord => {
    const out: DbRecord = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
    for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
      let value = row[columnName(field)];
      if (value !== null && value !== undefined && schema.def.kind === "number" && typeof value === "string") value = Number(value);
      // pgvector sends vectors as text: [1,2,3].
      if (typeof value === "string" && isVector(schema)) value = JSON.parse(value);
      out[field] = value ?? null;
    }
    return out;
  };

  const whereSql = (model: AnyModel, conditions: Condition[], params: unknown[]): string => {
    if (!conditions.length) return "";
    const parts = conditions.map(({ field, op, value }) => {
      const col = q(columnName(field));
      const p = (v: unknown) => {
        params.push(toDb(model, field, v));
        return placeholder(model, field, params.length);
      };
      const list = (values: unknown[]) => {
        params.push(values.map((v) => toDb(model, field, v)));
        const schema = fieldSchema(model, field);
        if (schema && isVector(schema)) return `$${params.length}::text[]::vector[]`;
        return schema && isJson(schema) ? `$${params.length}::text[]::jsonb[]` : `$${params.length}`;
      };
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
          if (!(value as unknown[]).length) return "false";
          return `${col} = ANY(${list(value as unknown[])})`;
        case "notIn":
          if (!(value as unknown[]).length) return `${col} IS NOT NULL`;
          return `NOT (${col} = ANY(${list(value as unknown[])}))`;
        case "like":
          return `${col} LIKE ${p(value)}`;
        case "ilike":
          return `${col} ILIKE ${p(value)}`;
        case "isNull":
          return value ? `${col} IS NULL` : `${col} IS NOT NULL`;
      }
    });
    return ` WHERE ${parts.join(" AND ")}`;
  };

  const adapter: Adapter = {
    dialect: "postgres",
    connect(models) {
      setModels(new Map(models.map((m) => [m.name, m])));
    },
    async insert(model, row) {
      const fields = Object.keys(row);
      const params = fields.map((f) => toDb(model, f, row[f]));
      const sql = `INSERT INTO ${q(model.name)} (${fields.map((f) => q(columnName(f))).join(", ")}) VALUES (${fields.map((f, i) => placeholder(model, f, i + 1)).join(", ")}) RETURNING *`;
      const result = await run(sql, params);
      return fromDb(model, result.rows[0]!);
    },
    async select(model, query: Query) {
      const params: unknown[] = [];
      let sql = `SELECT * FROM ${q(model.name)}${whereSql(model, query.where, params)}`;
      if (query.orderBy.length) sql += ` ORDER BY ${query.orderBy.map(([f, d]) => `${q(columnName(f))} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
      if (query.limit !== undefined) sql += ` LIMIT ${Number(query.limit)}`;
      if (query.offset) sql += ` OFFSET ${Number(query.offset)}`;
      return (await run(sql, params)).rows.map((r) => fromDb(model, r));
    },
    async update(model, where, patch) {
      const params: unknown[] = [];
      const sets = Object.keys(patch).map((f) => {
        params.push(toDb(model, f, patch[f]));
        return `${q(columnName(f))} = ${placeholder(model, f, params.length)}`;
      });
      const sql = `UPDATE ${q(model.name)} SET ${sets.join(", ")}${whereSql(model, where, params)} RETURNING *`;
      return (await run(sql, params)).rows.map((r) => fromDb(model, r));
    },
    async delete(model, where) {
      const params: unknown[] = [];
      return (await run(`DELETE FROM ${q(model.name)}${whereSql(model, where, params)}`, params)).rowCount ?? 0;
    },
    async count(model, where) {
      const params: unknown[] = [];
      const result = await run(`SELECT count(*)::int AS n FROM ${q(model.name)}${whereSql(model, where, params)}`, params);
      return Number(result.rows[0]?.n ?? 0);
    },
    async sync(models, options = {}) {
      const statements: string[] = [];
      for (const model of sortByReferences(models)) {
        const existing = options.dryRun
          ? await run(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [model.name]).catch(() => ({ rows: [] as DbRecord[] }))
          : await run(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [model.name]);
        const columns = new Set(existing.rows.map((r) => String(r.column_name)));
        if (!columns.size) {
          statements.push(...createTableSql(model));
          continue;
        }
        for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
          if (!columns.has(columnName(field))) statements.push(`ALTER TABLE ${q(model.name)} ADD COLUMN ${columnDefinition(model, field, schema, true)}`);
        }
        statements.push(...indexSql(model));
      }
      if (needsVectorExtension(statements)) statements.unshift(VECTOR_EXTENSION);
      if (!options.dryRun) for (const s of statements) await run(s);
      return statements;
    },
    async search(model, query) {
      const params: unknown[] = [JSON.stringify(query.vector)];
      const col = q(columnName(query.field));
      const where = whereSql(model, [...query.where, { field: query.field, op: "isNull", value: false }], params);
      const sql = `SELECT *, ${col} <=> $1::text::vector AS "inferlo_distance" FROM ${q(model.name)}${where} ORDER BY "inferlo_distance" LIMIT ${Number(query.limit)}`;
      return (await run(sql, params)).rows.map((r) => ({ row: fromDb(model, r), distance: Number(r.inferlo_distance) }));
    },
    async sql(text, params = []) {
      return (await run(text, params)).rows;
    },
    client,
    async transaction(fn) {
      const pool = (await client()) as PoolLike;
      if (typeof pool.connect !== "function") return fn(adapter);
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const tx = createPgAdapter(async () => conn, getModels, () => {}, debug, async () => {});
        const result = await fn(tx);
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    },
    close,
  };
  return adapter;
}

function translate(error: unknown): unknown {
  const e = error as { code?: string; detail?: string; table?: string; constraint?: string; message?: string };
  if (e && e.code === "23505") {
    return new InferloError("IL4004", "A row with this value already exists.", { status: 409, details: { table: e.table, constraint: e.constraint }, cause: error });
  }
  // 23503 is foreign_key_violation; PostgreSQL 18 reports an ON DELETE RESTRICT (or ON UPDATE RESTRICT)
  // violation as 23001 restrict_violation instead, so both mean the same thing to the app.
  if (e && (e.code === "23503" || e.code === "23001")) {
    return new InferloError("IL4011", "This references a row that does not exist (or is still referenced elsewhere).", {
      status: 409,
      details: { table: e.table, constraint: e.constraint },
      cause: error,
    });
  }
  if (e && e.code === "42P01") {
    return new InferloError("IL4012", `Table missing: ${e.message}`, { fix: "Run: inferlo db push", cause: error });
  }
  return error;
}
