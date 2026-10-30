/**
 * In-memory adapter for tests, prototypes and examples. Data is lost when the process exits.
 * Enforces unique fields the same way Postgres does (KR4004, HTTP 409).
 */
import { KairoError } from "../errors.ts";
import type { AnyModel } from "../model.ts";
import type { Adapter, Condition, DbRecord, Query } from "./types.ts";

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === null || x === undefined) return 1;
  if (y === null || y === undefined) return -1;
  return (x as number) < (y as number) ? -1 : 1;
}

function likeToRegex(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, flags);
}

function matches(row: DbRecord, conditions: Condition[]): boolean {
  return conditions.every(({ field, op, value }) => {
    const v = row[field];
    switch (op) {
      case "eq":
        return compare(v, value) === 0 && v !== null && v !== undefined;
      case "ne":
        return v !== null && v !== undefined && compare(v, value) !== 0;
      case "gt":
        return v != null && compare(v, value) > 0;
      case "gte":
        return v != null && compare(v, value) >= 0;
      case "lt":
        return v != null && compare(v, value) < 0;
      case "lte":
        return v != null && compare(v, value) <= 0;
      case "in":
        return (value as unknown[]).some((x) => compare(v, x) === 0);
      case "notIn":
        return v != null && !(value as unknown[]).some((x) => compare(v, x) === 0);
      case "like":
        return typeof v === "string" && likeToRegex(String(value), "").test(v);
      case "ilike":
        return typeof v === "string" && likeToRegex(String(value), "i").test(v);
      case "isNull":
        return value ? v === null || v === undefined : v !== null && v !== undefined;
    }
  });
}

function clone(row: DbRecord): DbRecord {
  return structuredClone(row);
}

export function memory(): Adapter {
  const tables = new Map<string, DbRecord[]>();
  const rowsOf = (model: AnyModel) => {
    let rows = tables.get(model.name);
    if (!rows) tables.set(model.name, (rows = []));
    return rows;
  };

  const checkUnique = (model: AnyModel, candidate: DbRecord, ignoreId?: unknown) => {
    for (const [field, schema] of Object.entries(model.fields as Record<string, { def: { unique?: boolean } }>)) {
      if (!schema.def.unique || candidate[field] == null) continue;
      const clash = rowsOf(model).find((r) => r.id !== ignoreId && compare(r[field], candidate[field]) === 0);
      if (clash) {
        throw new KairoError("KR4004", `A ${model.name} row with this ${field} already exists.`, { status: 409, details: { table: model.name, field } });
      }
    }
  };

  return {
    dialect: "memory",
    async insert(model, row) {
      checkUnique(model, row);
      const stored = clone(row);
      for (const key of Object.keys(model.fields)) if (!(key in stored)) stored[key] = null;
      rowsOf(model).push(stored);
      return clone(stored);
    },
    async select(model, query: Query) {
      let rows = rowsOf(model).filter((r) => matches(r, query.where));
      if (query.orderBy.length) {
        rows = [...rows].sort((a, b) => {
          for (const [field, dir] of query.orderBy) {
            const c = compare(a[field], b[field]);
            if (c !== 0) return dir === "asc" ? c : -c;
          }
          return 0;
        });
      }
      const start = query.offset ?? 0;
      return rows.slice(start, query.limit === undefined ? undefined : start + query.limit).map(clone);
    },
    async update(model, where, patch) {
      const out: DbRecord[] = [];
      for (const row of rowsOf(model)) {
        if (!matches(row, where)) continue;
        checkUnique(model, { ...row, ...patch }, row.id);
        Object.assign(row, clone(patch));
        out.push(clone(row));
      }
      return out;
    },
    async delete(model, where) {
      const rows = rowsOf(model);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      tables.set(model.name, keep);
      return removed;
    },
    async count(model, where) {
      return rowsOf(model).filter((r) => matches(r, where)).length;
    },
    async sync(models) {
      for (const m of models) rowsOf(m);
      return [];
    },
    async close() {
      tables.clear();
    },
  };
}
