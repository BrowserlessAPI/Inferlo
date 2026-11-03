/**
 * Typed table clients: db.tickets.insert(...), db.tickets.findMany({ where: { status: "open" } }).
 * Inserts and updates are always validated against the model, and every query is parameterised.
 */
import { InferloError, didYouMean, notFound } from "../errors.ts";
import type { AnyModel, Row, CreateInput, UpdateInput } from "../model.ts";
import type { AnySchema } from "../schema.ts";
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

type RefTable<S> = S extends { readonly _ref: infer T extends string } ? T : never;

/** Relations of a model: one per t.ref field named <name>Id, mapped to the referenced table. ownerId: t.ref("users") gives owner -> "users". */
export type Relations<M extends AnyModel> = {
  [K in keyof M["fields"] & string as K extends `${infer R}Id` ? ([RefTable<M["fields"][K]>] extends [never] ? never : R) : never]: RefTable<M["fields"][K]>;
};

/** Which relations to load: { owner: true }. */
export type Include<M extends AnyModel> = { [R in keyof Relations<M>]?: boolean };

type ModelNamed<Models extends readonly AnyModel[], N> = Extract<Models[number], { name: N }> extends infer T extends AnyModel ? ([T] extends [never] ? AnyModel : T) : AnyModel;
type RefValue<M extends AnyModel, R extends string> = `${R}Id` extends keyof Row<M> ? Row<M>[`${R}Id`] : never;

/** A row with the included relations: Row<typeof Ticket> & { owner: Row<typeof User> }. Optional refs may be null. */
export type WithInclude<M extends AnyModel, Models extends readonly AnyModel[], I> = Row<M> & {
  [R in keyof I & keyof Relations<M> & string as I[R] extends true ? R : never]:
    | Row<ModelNamed<Models, Relations<M>[R]>>
    | (null extends RefValue<M, R> ? null : undefined extends RefValue<M, R> ? null : never);
};

/** Options for reading one row. */
export interface FindOptions<I> {
  /** Load related rows of t.ref fields: { owner: true } adds row.owner for ownerId. One extra query per relation. */
  include?: I;
}

const OPS: Op[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "ilike", "isNull"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export class Table<M extends AnyModel, Models extends readonly AnyModel[] = readonly AnyModel[]> {
  readonly model: M;
  #adapter: () => Adapter;
  #models: readonly AnyModel[];

  constructor(model: M, adapter: () => Adapter, models: readonly AnyModel[] = [model]) {
    this.model = model;
    this.#adapter = adapter;
    this.#models = models;
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
  async find<const I extends Include<M> = {}>(id: string, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I> | null> {
    const relations = this.#relations(options.include);
    const rows = await this.#adapter().select(this.model, { where: [{ field: "id", op: "eq", value: id }], orderBy: [], limit: 1 });
    await this.#load(rows, relations);
    return (rows[0] as WithInclude<M, Models, I>) ?? null;
  }

  /** Row by id. Throws IL4001 (HTTP 404) when it does not exist. */
  async get<const I extends Include<M> = {}>(id: string, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I>> {
    const row = await this.find(id, options);
    if (!row) throw notFound(`${singular(this.model.name)} ${id} was not found.`, { table: this.model.name, id });
    return row;
  }

  /** First row matching where, or null. */
  async findOne<const I extends Include<M> = {}>(where: Where<Row<M>>, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I> | null> {
    const rows = await this.findMany({ where, limit: 1, include: options.include });
    return rows[0] ?? null;
  }

  /** Rows matching where. include: { owner: true } loads related rows with one extra query per relation. */
  async findMany<const I extends Include<M> = {}>(options: FindManyOptions<Row<M>> & FindOptions<I> = {}): Promise<WithInclude<M, Models, I>[]> {
    const relations = this.#relations(options.include);
    const rows = await this.#adapter().select(this.model, this.#query(options));
    await this.#load(rows, relations);
    return rows as WithInclude<M, Models, I>[];
  }

  /** Relation name, ref field and target model for each included relation. Unknown names raise IL4023. */
  #relations(include: object | undefined): { name: string; field: string; target: AnyModel }[] {
    if (!include) return [];
    const available = Object.entries(this.model.fields as Record<string, AnySchema>)
      .filter(([field, schema]) => schema.def.kind === "ref" && field.length > 2 && field.endsWith("Id") && !(field.slice(0, -2) in this.model.fields))
      .map(([field, schema]) => ({ name: field.slice(0, -2), field, table: schema.def.refTable! }));
    const out: { name: string; field: string; target: AnyModel }[] = [];
    for (const [name, wanted] of Object.entries(include)) {
      if (wanted === undefined || wanted === false) continue;
      const relation = available.find((r) => r.name === name);
      if (!relation || wanted !== true) {
        const names = available.map((r) => r.name);
        throw new InferloError(
          "IL4023",
          relation ? `include.${name} must be true or false.` : `"${this.model.name}" has no relation "${name}".${didYouMean(name, names)}`,
          {
            fix: names.length
              ? `Relations of "${this.model.name}": ${available.map((r) => `${r.name} (${r.field})`).join(", ")}. Use include: { ${names[0]}: true }.`
              : `"${this.model.name}" has no t.ref fields named <name>Id. Add one, e.g. ownerId: t.ref("users"), to include owner.`,
          },
        );
      }
      const target = this.#models.find((m) => m.name === relation.table);
      if (!target) throw new InferloError("IL6005", `${this.model.name}.${relation.field} references "${relation.table}", which is not a registered model.`);
      out.push({ name, field: relation.field, target });
    }
    return out;
  }

  /** One query per relation: every referenced id at once, never one query per row. */
  async #load(rows: DbRecord[], relations: { name: string; field: string; target: AnyModel }[]): Promise<void> {
    for (const relation of relations) {
      const ids = [...new Set(rows.map((row) => row[relation.field]).filter((id): id is string => typeof id === "string"))];
      const related = ids.length
        ? await this.#adapter().select(relation.target, { where: [{ field: "id", op: "in", value: ids }], orderBy: [], limit: ids.length })
        : [];
      const byId = new Map(related.map((r) => [r.id as string, r]));
      for (const row of rows) row[relation.name] = (typeof row[relation.field] === "string" ? byId.get(row[relation.field] as string) : undefined) ?? null;
    }
  }

  async count(where: Where<Row<M>> = {}): Promise<number> {
    return this.#adapter().count(this.model, this.#where(where));
  }

  /** Validate and update one row by id. Throws IL4001 (HTTP 404) when it does not exist. */
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
      throw new InferloError("IL4007", `deleteMany() on "${this.model.name}" needs a where filter.`, {
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
      throw new InferloError("IL4003", `Unknown field "${field}" in ${where} on "${this.model.name}".${didYouMean(field, this.#fields)}`, {
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
            throw new InferloError("IL4003", `Unknown operator "${op}" for "${field}".${didYouMean(op, OPS)}`, {
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
        throw new InferloError("IL4003", `orderBy direction for "${field}" must be "asc" or "desc".`);
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
export type Db<Models extends readonly AnyModel[]> = { [M in Models[number] as M["name"]]: Table<M, Models> } & DbHelpers;

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
    for (const m of models) db[m.name] = new Table(m, () => current, models);
    const helpers: DbHelpers = {
      $adapter: current,
      $sync: (options) => current.sync([...models], options),
      $transaction: async (fn) => (current.transaction ? current.transaction((tx) => fn(build(tx))) : fn(build(current))),
      $sql: async (text, params) => {
        if (!current.sql) throw new InferloError("IL4008", `Raw SQL is not supported by the ${current.dialect} adapter.`, { fix: "Use postgres() from @browserlessapi/inferlo/postgres." });
        return current.sql(text, params);
      },
      $close: async () => current.close?.(),
    };
    Object.assign(db, helpers);
    return new Proxy(db, {
      get(target, prop) {
        if (typeof prop === "string" && !(prop in target) && !prop.startsWith("$") && prop !== "then" && prop !== "toJSON") {
          const names = models.map((m) => m.name);
          throw new InferloError("IL4002", `db.${prop} does not exist.${didYouMean(prop, names)}`, {
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
