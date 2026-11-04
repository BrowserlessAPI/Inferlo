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

export interface PaginateOptions<R> {
  where?: Where<R>;
  /**
   * One field and direction: { createdAt: "desc" } (default { createdAt: "asc" }). Rows with the same
   * value are ordered by id. The field must be required (not optional or nullable) and not json, array or object.
   */
  orderBy?: OrderBy<R>;
  /** nextCursor from the previous page. Leave out (or null) for the first page. */
  cursor?: string | null;
  /** Rows per page. Default 100, maximum 1000. */
  limit?: number;
}

/** One page: the rows, and the cursor for the next page (null on the last page). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type RefTable<S> = S extends { readonly _ref: infer T extends string } ? T : never;

/** Relations of a model: one per t.ref field named <name>Id, mapped to the referenced table. ownerId: t.ref("users") gives owner -> "users". */
export type Relations<M extends AnyModel> = {
  [K in keyof M["fields"] & string as K extends `${infer R}Id` ? ([RefTable<M["fields"][K]>] extends [never] ? never : R) : never]: RefTable<M["fields"][K]>;
};

type IsUnion<U, A = U> = U extends unknown ? ([A] extends [U] ? false : true) : never;

/** Relation names R of the fields <R>Id in X that reference table T. */
type RefFieldsTo<X extends AnyModel, T extends string> = {
  [K in keyof X["fields"] & string]: K extends `${infer R}Id`
    ? [RefTable<X["fields"][K]>] extends [never]
      ? never
      : string extends RefTable<X["fields"][K]>
        ? never
        : RefTable<X["fields"][K]> extends T
          ? R
          : never
    : never;
}[keyof X["fields"] & string];

type ReverseKey<X extends AnyModel, T extends string, F extends string = RefFieldsTo<X, T>> = [F] extends [never]
  ? never
  : true extends IsUnion<F>
    ? `${X["name"]}By${Capitalize<F>}`
    : X["name"];

/**
 * Reverse (has-many) relations of a model: one per model in Models with a t.ref field named <name>Id
 * to this model, named after that model's table (users gets tickets). When a model has several such
 * fields, each is named <table>By<Name> (ticketsByOwner, ticketsByAssignee).
 */
export type ReverseRelations<M extends AnyModel, Models extends readonly AnyModel[]> = {
  [X in Models[number] as Exclude<ReverseKey<X, M["name"]>, keyof M["fields"] | keyof Relations<M> | "id" | "createdAt" | "updatedAt">]: X;
};

/** Which relations to load: { owner: true } for a t.ref field, { tickets: true } for the rows that reference this one. */
export type Include<M extends AnyModel, Models extends readonly AnyModel[] = readonly []> = {
  [R in keyof Relations<M> | keyof ReverseRelations<M, Models>]?: boolean;
};

type ModelNamed<Models extends readonly AnyModel[], N> = Extract<Models[number], { name: N }> extends infer T extends AnyModel ? ([T] extends [never] ? AnyModel : T) : AnyModel;
type RefValue<M extends AnyModel, R extends string> = `${R}Id` extends keyof Row<M> ? Row<M>[`${R}Id`] : never;

/** A row with the included relations: Row<typeof Ticket> & { owner: Row<typeof User> }. Optional refs may be null. */
export type WithInclude<M extends AnyModel, Models extends readonly AnyModel[], I> = Row<M> & {
  [R in keyof I & keyof Relations<M> & string as I[R] extends true ? R : never]:
    | Row<ModelNamed<Models, Relations<M>[R]>>
    | (null extends RefValue<M, R> ? null : undefined extends RefValue<M, R> ? null : never);
} & {
  [R in keyof I & keyof ReverseRows<M, Models> & string as I[R] extends true ? R : never]: ReverseRows<M, Models>[R];
};

type ReverseRows<M extends AnyModel, Models extends readonly AnyModel[]> = {
  [K in keyof ReverseRelations<M, Models>]: Row<ReverseModel<M, Models, K>>[];
};

type ReverseModel<M extends AnyModel, Models extends readonly AnyModel[], K> = Models[number] extends infer X
  ? X extends AnyModel
    ? K extends ReverseKey<X, M["name"]>
      ? X
      : never
    : never
  : never;

/** Options for reading one row. */
export interface FindOptions<I> {
  /** Load related rows: { owner: true } adds row.owner for ownerId, { tickets: true } adds row.tickets (rows that reference this one). One extra query per relation. */
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
  async find<const I extends Include<M, Models> = {}>(id: string, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I> | null> {
    const relations = this.#relations(options.include);
    const rows = await this.#adapter().select(this.model, { where: [{ field: "id", op: "eq", value: id }], orderBy: [], limit: 1 });
    await this.#load(rows, relations);
    return (rows[0] as WithInclude<M, Models, I>) ?? null;
  }

  /** Row by id. Throws IL4001 (HTTP 404) when it does not exist. */
  async get<const I extends Include<M, Models> = {}>(id: string, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I>> {
    const row = await this.find(id, options);
    if (!row) throw notFound(`${singular(this.model.name)} ${id} was not found.`, { table: this.model.name, id });
    return row;
  }

  /** First row matching where, or null. */
  async findOne<const I extends Include<M, Models> = {}>(where: Where<Row<M>>, options: FindOptions<I> = {}): Promise<WithInclude<M, Models, I> | null> {
    const rows = await this.findMany({ where, limit: 1, include: options.include });
    return rows[0] ?? null;
  }

  /** Rows matching where. include: { owner: true } loads related rows with one extra query per relation. */
  async findMany<const I extends Include<M, Models> = {}>(options: FindManyOptions<Row<M>> & FindOptions<I> = {}): Promise<WithInclude<M, Models, I>[]> {
    const relations = this.#relations(options.include);
    const rows = await this.#adapter().select(this.model, this.#query(options));
    await this.#load(rows, relations);
    return rows as WithInclude<M, Models, I>[];
  }

  /**
   * One page of rows in a stable order, for "load more" and API pagination:
   * const { items, nextCursor } = await db.tickets.paginate({ where, orderBy: { createdAt: "desc" }, cursor, limit: 20 }).
   * Pass nextCursor back as cursor for the next page; it is null on the last page. Pages never skip or repeat
   * rows when rows are added or removed elsewhere in the list (keyset pagination, no offset).
   */
  async paginate<const I extends Include<M, Models> = {}>(options: PaginateOptions<Row<M>> & FindOptions<I> = {}): Promise<Page<WithInclude<M, Models, I>>> {
    if ("offset" in options) {
      throw new InferloError("IL4025", `paginate() on "${this.model.name}" does not take offset.`, {
        fix: "Pass the previous page's nextCursor as cursor. Use findMany({ offset }) for numbered pages.",
      });
    }
    const relations = this.#relations(options.include);
    const [field, direction] = this.#pageOrder(options.orderBy);
    const base = this.#query({ where: options.where, limit: options.limit });
    const limit = base.limit!;
    const after = options.cursor == null ? null : this.#decodeCursor(options.cursor, field, direction);
    const next = direction === "asc" ? "gt" : "lt";
    const take = limit + 1;
    let rows: DbRecord[];
    if (!after) {
      rows = await this.#adapter().select(this.model, { where: base.where, orderBy: field === "id" ? [["id", direction]] : [[field, direction], ["id", direction]], limit: take });
    } else if (field === "id") {
      rows = await this.#adapter().select(this.model, { where: [...base.where, { field: "id", op: next, value: after.id }], orderBy: [["id", direction]], limit: take });
    } else {
      // Keyset (field, id) > (value, id) as two queries, because conditions are combined with AND:
      // the rest of the rows with the same value, then the rows after that value.
      rows = await this.#adapter().select(this.model, {
        where: [...base.where, { field, op: "eq", value: after.value }, { field: "id", op: next, value: after.id }],
        orderBy: [["id", direction]],
        limit: take,
      });
      if (rows.length < take) {
        rows = rows.concat(
          await this.#adapter().select(this.model, {
            where: [...base.where, { field, op: next, value: after.value }],
            orderBy: [[field, direction], ["id", direction]],
            limit: take - rows.length,
          }),
        );
      }
    }
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last ? encodeCursor(field, direction, last[field], String(last.id)) : null;
    await this.#load(items, relations);
    return { items: items as WithInclude<M, Models, I>[], nextCursor };
  }

  /** The one field paginate() orders by. */
  #pageOrder(raw: OrderBy<any> | undefined): [string, "asc" | "desc"] {
    const entries = (Array.isArray(raw) ? raw : Object.entries(raw ?? {})) as [string, string][];
    if (entries.length > 1) {
      throw new InferloError("IL4025", `paginate() on "${this.model.name}" orders by one field, got ${entries.map(([f]) => f).join(", ")}.`, {
        fix: 'Use one field, e.g. orderBy: { createdAt: "desc" }. Rows with the same value are ordered by id.',
      });
    }
    const [field, direction] = entries[0] ?? ["createdAt", "asc"];
    this.#checkField(field, "orderBy");
    if (direction !== "asc" && direction !== "desc") throw new InferloError("IL4003", `orderBy direction for "${field}" must be "asc" or "desc".`);
    const def = (this.model.row.shape as Record<string, AnySchema>)[field]!.def;
    if (!SORTABLE.has(def.kind) || def.nullable || (def.optional && !def.hasDefault)) {
      throw new InferloError("IL4025", `paginate() on "${this.model.name}" cannot order by "${field}": it is ${def.nullable || def.optional ? "optional or nullable" : `a ${def.kind} field`}.`, {
        fix: "Order by a required field such as createdAt, a number, a date or a string, or give the field a default.",
      });
    }
    return [field, direction];
  }

  #decodeCursor(cursor: string, field: string, direction: "asc" | "desc"): { value: unknown; id: string } {
    const bad = (why: string) =>
      new InferloError("IL4024", `Invalid cursor for ${this.model.name}: ${why}.`, {
        status: 400,
        expose: true,
        fix: "Pass the nextCursor from the previous page unchanged, with the same orderBy. Leave cursor out for the first page.",
      });
    let data: { f?: unknown; d?: unknown; v?: unknown; id?: unknown };
    try {
      data = JSON.parse(base64urlDecode(cursor));
    } catch {
      throw bad("it is not a cursor from paginate()");
    }
    if (!data || typeof data !== "object") throw bad("it is not a cursor from paginate()");
    if (data.f !== field || data.d !== direction) throw bad(`it was made for orderBy ${String(data.f)} ${String(data.d)}, not ${field} ${direction}`);
    if (typeof data.id !== "string" || !UUID.test(data.id)) throw bad("the id is not valid");
    const schema = (this.model.row.shape as Record<string, AnySchema>)[field]!;
    const parsed = schema.safeParse(data.v);
    if (!parsed.ok) throw bad(`the ${field} value is not valid`);
    return { value: parsed.value, id: data.id };
  }

  /**
   * Relations of this model. "one": a t.ref field <name>Id of this model (owner for ownerId).
   * "many": a t.ref field <name>Id of another model that points here (tickets for tickets.ownerId,
   * or ticketsByOwner when tickets has several such fields).
   */
  #available(): Relation[] {
    const eligible = (m: AnyModel) =>
      Object.entries(m.fields as Record<string, AnySchema>).filter(
        ([field, schema]) => schema.def.kind === "ref" && field.length > 2 && field.endsWith("Id") && !(field.slice(0, -2) in m.fields),
      );
    const forward: Relation[] = [];
    for (const [field, schema] of eligible(this.model)) {
      const target = this.#models.find((m) => m.name === schema.def.refTable);
      forward.push({ kind: "one", name: field.slice(0, -2), field, table: schema.def.refTable!, target });
    }
    const taken = new Set([...this.#fields, ...forward.map((r) => r.name)]);
    const reverse: Relation[] = [];
    for (const m of this.#models) {
      const fields = eligible(m).filter(([, schema]) => schema.def.refTable === this.model.name);
      for (const [field] of fields) {
        const relation = field.slice(0, -2);
        const name = fields.length === 1 ? m.name : `${m.name}By${relation.charAt(0).toUpperCase()}${relation.slice(1)}`;
        if (!taken.has(name)) reverse.push({ kind: "many", name, field, table: m.name, target: m });
      }
    }
    return [...forward, ...reverse];
  }

  /** The included relations. Unknown names raise IL4023. */
  #relations(include: object | undefined): Relation[] {
    if (!include) return [];
    const available = this.#available();
    const out: Relation[] = [];
    for (const [name, wanted] of Object.entries(include)) {
      if (wanted === undefined || wanted === false) continue;
      const relation = available.find((r) => r.name === name);
      if (!relation || wanted !== true) {
        const names = available.map((r) => r.name);
        const ambiguous = available.filter((r) => r.kind === "many" && r.table === name);
        throw new InferloError(
          "IL4023",
          relation
            ? `include.${name} must be true or false.`
            : ambiguous.length
              ? `"${name}" has several t.ref fields to "${this.model.name}", so include.${name} is ambiguous.`
              : `"${this.model.name}" has no relation "${name}".${didYouMean(name, names)}`,
          {
            fix: ambiguous.length
              ? `Name the field: ${ambiguous.map((r) => `${r.name} (${name}.${r.field})`).join(", ")}. Use include: { ${ambiguous[0]!.name}: true }.`
              : names.length
                ? `Relations of "${this.model.name}": ${available.map(describeRelation).join(", ")}. Use include: { ${names[0]}: true }.`
                : `"${this.model.name}" has no relations. Add a t.ref field named <name>Id, e.g. ownerId: t.ref("users"), to include owner; models that reference "${this.model.name}" that way can be included by their table name.`,
          },
        );
      }
      if (!relation.target) throw new InferloError("IL6005", `${this.model.name}.${relation.field} references "${relation.table}", which is not a registered model.`);
      out.push(relation);
    }
    return out;
  }

  /** One query per relation: every referenced id at once, never one query per row. */
  async #load(rows: DbRecord[], relations: Relation[]): Promise<void> {
    for (const relation of relations) {
      const target = relation.target!;
      if (relation.kind === "many") {
        const ids = [...new Set(rows.map((row) => row.id as string))];
        const related = ids.length
          ? await this.#adapter().select(target, { where: [{ field: relation.field, op: "in", value: ids }], orderBy: [["createdAt", "asc"], ["id", "asc"]] })
          : [];
        const byParent = new Map<string, DbRecord[]>();
        for (const r of related) {
          const list = byParent.get(r[relation.field] as string);
          if (list) list.push(r);
          else byParent.set(r[relation.field] as string, [r]);
        }
        for (const row of rows) row[relation.name] = byParent.get(row.id as string) ?? [];
        continue;
      }
      const ids = [...new Set(rows.map((row) => row[relation.field]).filter((id): id is string => typeof id === "string"))];
      const related = ids.length
        ? await this.#adapter().select(target, { where: [{ field: "id", op: "in", value: ids }], orderBy: [], limit: ids.length })
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

const SORTABLE = new Set(["string", "text", "email", "url", "uuid", "ref", "number", "int", "boolean", "date", "enum", "literal"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(field: string, direction: string, value: unknown, id: string): string {
  const v = value instanceof Date ? value.toISOString() : value;
  const json = JSON.stringify({ f: field, d: direction, v, id });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

interface Relation {
  kind: "one" | "many";
  name: string;
  /** The t.ref field: on this model for "one", on the related model for "many". */
  field: string;
  table: string;
  target: AnyModel | undefined;
}

function describeRelation(r: Relation): string {
  return r.kind === "one" ? `${r.name} (${r.field})` : `${r.name} (${r.table}.${r.field})`;
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
  adapter.connect?.([...models]);
  return bindDb(models, adapter);
}

/** A db client over an adapter that is already connected. Internal: createApp uses it for each request's ctx.db. */
export function bindDb<const Models extends readonly AnyModel[]>(models: Models, adapter: Adapter): Db<Models> {
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
  return build(adapter);
}

/**
 * An adapter that refuses new calls once signal is aborted, throwing signal.reason. A call already running
 * finishes. Transactions get the same guard, so an aborted transaction rolls back.
 */
export function guardAdapter(adapter: Adapter, signal: AbortSignal): Adapter {
  const check = () => {
    if (signal.aborted) throw signal.reason;
  };
  const guarded: Adapter = {
    ...adapter,
    insert: async (model, row) => (check(), adapter.insert(model, row)),
    select: async (model, query) => (check(), adapter.select(model, query)),
    update: async (model, where, patch) => (check(), adapter.update(model, where, patch)),
    delete: async (model, where) => (check(), adapter.delete(model, where)),
    count: async (model, where) => (check(), adapter.count(model, where)),
    sync: async (models, options) => (check(), adapter.sync(models, options)),
    close: async () => adapter.close?.(),
  };
  if (adapter.transaction) guarded.transaction = async (fn) => (check(), adapter.transaction!((tx) => fn(guardAdapter(tx, signal))));
  if (adapter.sql) guarded.sql = async (text, params) => (check(), adapter.sql!(text, params));
  return guarded;
}
