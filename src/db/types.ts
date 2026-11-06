import type { AnyModel } from "../model.ts";

export type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "like" | "ilike" | "isNull";

export interface Condition {
  field: string;
  op: Op;
  value: unknown;
}

export interface Query {
  where: Condition[];
  orderBy: [field: string, direction: "asc" | "desc"][];
  limit?: number;
  offset?: number;
}

export type DbRecord = Record<string, unknown>;

/**
 * Storage backend. Inferlo ships memory() and postgres(). Adapters receive validated,
 * already-normalised data with camelCase field names.
 */
export interface Adapter {
  readonly dialect: string;
  connect?(models: AnyModel[]): Promise<void> | void;
  insert(model: AnyModel, row: DbRecord): Promise<DbRecord>;
  select(model: AnyModel, query: Query): Promise<DbRecord[]>;
  update(model: AnyModel, where: Condition[], patch: DbRecord): Promise<DbRecord[]>;
  delete(model: AnyModel, where: Condition[]): Promise<number>;
  count(model: AnyModel, where: Condition[]): Promise<number>;
  /** Create missing tables, columns and indexes. Returns the statements it ran (or would run). */
  sync(models: AnyModel[], options?: { dryRun?: boolean }): Promise<string[]>;
  /** Run fn inside a transaction, passing an adapter bound to it. */
  transaction?<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>;
  /** Raw parameterised SQL (Postgres only). */
  sql?(text: string, params?: unknown[]): Promise<DbRecord[]>;
  /** The pg client queries run on (Postgres only): the pool, or a transaction's connection. */
  client?(): Promise<unknown>;
  close?(): Promise<void>;
}
