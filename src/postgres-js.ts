/**
 * postgres.js (the `postgres` package) as the connection pool of Inferlo's Postgres adapter, so an app that uses
 * postgres.js keeps one pool and writes postgres.js queries and Inferlo models in one transaction.
 *
 *   import postgresJs from "postgres";
 *   import { postgres } from "@browserlessapi/inferlo/postgres";
 *   import { postgresJsPool } from "@browserlessapi/inferlo/postgres-js";
 *
 *   export const sql = postgresJs(process.env.DATABASE_URL!, { max: 10 });
 *   createApp({ db: postgres({ pool: postgresJsPool(sql) }), ... });
 *
 *   db.$transaction(async (tx) => {
 *     const { sql } = await tx.$pgClient<PostgresJsClient>(); // the transaction's connection
 *     await sql`insert into crm_contacts ${sql({ email })}`;
 *     await tx.contact_notes.insert({ ... });
 *   });
 *
 * postgres.js is an optional peer dependency (3.4 and later); this entry point never imports it, it only uses the
 * `sql` instance it is given. No runtime dependencies.
 */
import { InferloError } from "./errors.ts";

/** The part of a postgres.js `sql` instance or reserved connection Inferlo's queries use. */
export interface PostgresJsQueryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js types its parameters per instance.
  unsafe(query: string, parameters?: any[]): PromiseLike<unknown[] & { count?: number | null }>;
}

/** The parts of a postgres.js `sql` instance Inferlo uses: queries, and reserve() for transactions. */
export interface PostgresJsSql extends PostgresJsQueryable {
  reserve(): Promise<PostgresJsQueryable & { release(): void }>;
}

/**
 * What `db.$pgClient()` returns with postgresJsPool(): `sql` is the pool's instance, or inside db.$transaction
 * the transaction's reserved connection: `tx.$pgClient<PostgresJsClient<ReservedSql>>()` with
 * `import type { ReservedSql } from "postgres"`.
 */
export interface PostgresJsClient<S = PostgresJsQueryable> {
  /** postgres.js on the pool, or inside db.$transaction the transaction's reserved connection: `await sql\`...\``. */
  readonly sql: S;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** The pool that postgres({ pool }) takes. */
export interface PostgresJsPool<S = PostgresJsSql> extends PostgresJsClient<S> {
  connect(): Promise<PostgresJsClient & { release(): void }>;
  /** Does nothing: the app created `sql` and ends it with `await sql.end()` after `app.close()`. */
  end(): Promise<void>;
}

/** postgres.js errors name the table and constraint differently from pg; Inferlo's errors read pg's names. */
function asPgError(error: unknown): unknown {
  if (error && typeof error === "object") {
    const e = error as { table_name?: unknown; constraint_name?: unknown; table?: unknown; constraint?: unknown };
    if (e.table === undefined && typeof e.table_name === "string") e.table = e.table_name;
    if (e.constraint === undefined && typeof e.constraint_name === "string") e.constraint = e.constraint_name;
  }
  return error;
}

function client<S extends PostgresJsQueryable>(sql: S): PostgresJsClient<S> {
  return {
    sql,
    async query(text, params = []) {
      try {
        // Inferlo builds each statement from model definitions and sends every value as a parameter.
        const result = await sql.unsafe(text, params);
        return { rows: [...result] as Record<string, unknown>[], rowCount: typeof result.count === "number" ? result.count : null };
      } catch (error) {
        throw asPgError(error);
      }
    },
  };
}

/**
 * A postgres.js `sql` instance as the pool of Inferlo's Postgres adapter: `postgres({ pool: postgresJsPool(sql) })`.
 * Inferlo's queries and transactions use postgres.js's connections; `tx.$pgClient<PostgresJsClient>()` gives the
 * transaction's connection as `sql`.
 */
export function postgresJsPool<S extends PostgresJsSql>(sql: S): PostgresJsPool<S> {
  const given: unknown = sql;
  const parts = given as { unsafe?: unknown; reserve?: unknown };
  if (typeof given !== "function" || typeof parts.unsafe !== "function" || typeof parts.reserve !== "function") {
    throw new InferloError("IL4029", "postgresJsPool(sql) needs a postgres.js sql instance (3.4 or later).", {
      fix: 'Create it with postgres.js and pass it: import postgresJs from "postgres"; const sql = postgresJs(process.env.DATABASE_URL); postgres({ pool: postgresJsPool(sql) }).',
    });
  }
  return {
    ...client(sql),
    async connect() {
      // A reserved connection: postgres.js keeps it for this transaction until release().
      const reserved = await sql.reserve();
      return { ...client(reserved), release: () => reserved.release() };
    },
    async end() {},
  };
}
