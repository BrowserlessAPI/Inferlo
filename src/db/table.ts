/**
 * Typed table clients: db.tickets.insert(...), db.tickets.findMany({ where: { status: "open" } }).
 * Inserts and updates are always validated against the model, and every query is parameterised.
 */
import { KairoError, didYouMean, notFound } from "../errors.ts";
import type { AnyModel, Row, CreateInput, UpdateInput } from "../model.ts";
import { ValidationError } from "../schema.ts";
import type { Adapter, Condition, DbRecord, Op, Query } from "./types.ts";

type Comparable<V> = {
  eq?: V;
  ne?: V;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  in?: V[];
  notIn?: V[];
  like?: string;
  ilike?: string;
  isNull?: boolean;
};

/** Filter rows. A plain value means equals; use an object for other operators. */
export type Where<R> = { [K in keyof R]?: R[K] | Comparable<NonNullable<R[K]>> };
export type OrderBy<R> = { [K in keyof R]?: "asc" | "desc" } | [keyof R & string, "asc" | "desc"][];

export interface FindManyOptions<R> {
  where?: Where<R>;
  orderBy?: OrderBy<R>;
  /** Default 100, maximum 1000. */
  limit?: number;
  offset?: number;
}

const OPS: Op[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "ilike", "isNull"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export class Table<M extends AnyModel> {
  readonly model: M;
  #adapter: () => Adapter;

  constructor(model: M, adapter: () => Adapter) {
    this.model = model;
    this.#adapter = adapter;
  }

  get #fields(): string[] {
    return ["id", "createdAt", "updatedAt", ...Object.keys(this.model.fields)];
  }

  /** Validate and insert one row. Returns the stored row. */
  async insert(data: CreateInput<M>): Promise<Row<M>> {
    const parsed = this.#validate(this.model.create, data, "insert");
    const now = new Date();
    const row = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...parsed };
    return (await this.#adapter().insert(this.model, row)) as Row<M>;
  }

  async insertMany(items: CreateInput<M>[]): Promise<Row<M>[]> {
    const out: Row<M>[] = [];
    for (const item of items) out.push(await this.insert(item));
    return out;
  }

  /** Row by id, or null. */
  async find(id: string): Promise<Row<M> | null> {
    const rows = await this.#adapter().select(this.model, { where: [{ field: "id", op: "eq", value: id }], orderBy: [], limit: 1 });
    return (rows[0] as Row<M>) ?? null;
  }

  /** Row by id. Throws KR4001 (HTTP 404) when it does not exist. */
  async get(id: string): Promise<Row<M>> {
    const row = await this.find(id);
    if (!row) throw notFound(`${singular(this.model.name)} ${id} was not found.`, { table: this.model.name, id });
    return row;
  }

  /** First row matching where, or null. */
  async findOne(where: Where<Row<M>>): Promise<Row<M> | null> {
    const rows = await this.findMany({ where, limit: 1 });
    return rows[0] ?? null;
  }

  async findMany(options: FindManyOptions<Row<M>> = {}): Promise<Row<M>[]> {
    return (await this.#adapter().select(this.model, this.#query(options))) as Row<M>[];
  }

  async count(where: Where<Row<M>> = {}): Promise<number> {
    return this.#adapter().count(this.model, this.#where(where));
  }

  /** Validate and update one row by id. Throws KR4001 (HTTP 404) when it does not exist. */
  async update(id: string, patch: UpdateInput<M>): Promise<Row<M>> {
    const parsed = this.#validate(this.model.update, patch, "update");
    const rows = await this.#adapter().update(this.model, [{ field: "id", op: "eq", value: id }], { ...parsed, updatedAt: new Date() });
    if (!rows[0]) throw notFound(`${singular(this.model.name)} ${id} was not found.`, { table: this.model.name, id });
    return rows[0] as Row<M>;
  }

  /** Update every row matching where. Returns the updated rows. */
  async updateMany(where: Where<Row<M>>, patch: UpdateInput<M>): Promise<Row<M>[]> {
    const conditions = this.#where(where);
    const parsed = this.#validate(this.model.update, patch, "update");
    return (await this.#adapter().update(this.model, conditions, { ...parsed, updatedAt: new Date() })) as Row<M>[];
  }

  /** Delete by id. Returns true if a row was deleted. */
  async delete(id: string): Promise<boolean> {
    return (await this.#adapter().delete(this.model, [{ field: "id", op: "eq", value: id }])) > 0;
  }

  /** Delete every row matching where. Refuses an empty where to prevent accidental wipes. */
  async deleteMany(where: Where<Row<M>>): Promise<number> {
    const conditions = this.#where(where);
    if (!conditions.length) {
      throw new KairoError("KR4007", `deleteMany() on "${this.model.name}" needs a where filter.`, {
        fix: "Pass a filter, e.g. deleteMany({ status: \"closed\" }). To delete everything use deleteMany({ id: { isNull: false } }).",
      });
    }
    return this.#adapter().delete(this.model, conditions);
  }

  #validate(schema: { safeParse(input: unknown): { ok: true; value: unknown } | { ok: false; issues: any[] } }, data: unknown, action: string): DbRecord {
    const result = schema.safeParse(data);
    if (!result.ok) throw new ValidationError(result.issues, `${singular(this.model.name)} ${action}`);
    return result.value as DbRecord;
  }

  #checkField(field: string, where: string): void {
    if (!this.#fields.includes(field)) {
      throw new KairoError("KR4003", `Unknown field "${field}" in ${where} on "${this.model.name}".${didYouMean(field, this.#fields)}`, {
        fix: `Use one of: ${this.#fields.join(", ")}`,
        status: 500,
      });
    }
  }

  #where(where: Where<any> = {}): Condition[] {
    const out: Condition[] = [];
    for (const [field, value] of Object.entries(where)) {
      if (value === undefined) continue;
      this.#checkField(field, "where");
      if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
        for (const [op, operand] of Object.entries(value)) {
          if (operand === undefined) continue;
          if (!OPS.includes(op as Op)) {
            throw new KairoError("KR4003", `Unknown operator "${op}" for "${field}".${didYouMean(op, OPS)}`, {
              fix: `Operators: ${OPS.join(", ")}`,
            });
          }
          out.push({ field, op: op as Op, value: operand });
        }
      } else if (value === null) {
        out.push({ field, op: "isNull", value: true });
      } else {
        out.push({ field, op: "eq", value });
      }
    }
    return out;
  }

  #query(options: FindManyOptions<any>): Query {
    const orderBy: Query["orderBy"] = [];
    const raw = options.orderBy;
    const entries = Array.isArray(raw) ? raw : Object.entries(raw ?? {});
    for (const [field, direction] of entries as [string, string][]) {
      this.#checkField(field, "orderBy");
      if (direction !== "asc" && direction !== "desc") {
        throw new KairoError("KR4003", `orderBy direction for "${field}" must be "asc" or "desc".`);
      }
      orderBy.push([field, direction]);
    }
    const limit = Math.min(Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return { where: this.#where(options.where), orderBy, limit, offset };
  }
}

function singular(name: string): string {
  const word = name.endsWith("ies") ? name.slice(0, -3) + "y" : name.endsWith("s") ? name.slice(0, -1) : name;
  return word.charAt(0).toUpperCase() + word.slice(1).replace(/_/g, " ");
}

/** db.<table> for every registered model, plus helpers. */
export type Db<Models extends readonly AnyModel[]> = { [M in Models[number] as M["name"]]: Table<M> } & DbHelpers;

export interface DbHelpers {
  /** The underlying adapter. */
  readonly $adapter: Adapter;
  /** Create missing tables, columns and indexes. */
  $sync(options?: { dryRun?: boolean }): Promise<string[]>;
  /** Run fn in a transaction (Postgres). With memory() it simply runs fn. */
  $transaction<T>(fn: (tx: Db<any>) => Promise<T>): Promise<T>;
  /** Raw parameterised SQL (Postgres): $sql("select * from tickets where id = $1", [id]). */
  $sql(text: string, params?: unknown[]): Promise<DbRecord[]>;
  $close(): Promise<void>;
}

export function createDb<const Models extends readonly AnyModel[]>(models: Models, adapter: Adapter): Db<Models> {
  const build = (current: Adapter): Db<Models> => {
    const db: Record<string, unknown> = {};
    for (const m of models) db[m.name] = new Table(m, () => current);
    const helpers: DbHelpers = {
      $adapter: current,
      $sync: (options) => current.sync([...models], options),
      $transaction: async (fn) => (current.transaction ? current.transaction((tx) => fn(build(tx))) : fn(build(current))),
      $sql: async (text, params) => {
        if (!current.sql) throw new KairoError("KR4008", `Raw SQL is not supported by the ${current.dialect} adapter.`, { fix: "Use postgres() from @kairojs/core/postgres." });
        return current.sql(text, params);
      },
      $close: async () => current.close?.(),
    };
    Object.assign(db, helpers);
    return new Proxy(db, {
      get(target, prop) {
        if (typeof prop === "string" && !(prop in target) && !prop.startsWith("$") && prop !== "then" && prop !== "toJSON") {
          const names = models.map((m) => m.name);
          throw new KairoError("KR4002", `db.${prop} does not exist.${didYouMean(prop, names)}`, {
            fix: `Registered tables: ${names.join(", ") || "(none)"}. Add the model to createApp({ models: [...] }).`,
          });
        }
        return Reflect.get(target, prop);
      },
    }) as Db<Models>;
  };
  adapter.connect?.([...models]);
  return build(adapter);
}
