/**
 * In-memory adapter for tests, prototypes and examples. Data is lost when the process exits.
 * Enforces unique fields the same way Postgres does (IL4004, HTTP 409).
 */
import { InferloError } from "../errors.ts";
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

/** 1 minus the cosine similarity, as pgvector's <=> operator: 0 for the same direction, 2 for the opposite. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / Math.sqrt(na * nb);
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
      // Unique per tenant on tenant-scoped models, as the Postgres index (tenant_id, column).
      const clash = rowsOf(model).find((r) => r.id !== ignoreId && compare(r[field], candidate[field]) === 0 && (!model.tenant || r.tenantId === candidate.tenantId));
      if (clash) {
        throw new InferloError("IL4004", `A ${model.name} row with this ${field} already exists.`, { status: 409, details: { table: model.name, field } });
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
    async search(model, query) {
      const scored = rowsOf(model)
        .filter((r) => Array.isArray(r[query.field]) && matches(r, query.where))
        .map((row) => ({ row, distance: cosineDistance(row[query.field] as number[], query.vector) }));
      // As in pgvector, NaN (a zero vector) sorts after every number.
      scored.sort((a, b) => (Number.isNaN(a.distance) ? 1 : Number.isNaN(b.distance) ? -1 : a.distance - b.distance));
      return scored.slice(0, query.limit).map(({ row, distance }) => ({ row: clone(row), distance }));
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
