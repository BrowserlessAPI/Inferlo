/**
 * Rate limiting per route: route.post("/login", { auth: "public", rateLimit: { max: 5, per: "minute", by: "ip" } }).
 * Fixed windows, counted in memory (one process) or in the database (shared by every instance).
 */
import type { Adapter } from "./db/types.ts";
import { InferloError } from "./errors.ts";

export interface RateLimit {
  /** Requests allowed per window. */
  max: number;
  /** Window length. */
  per: "second" | "minute" | "hour" | "day";
  /**
   * Who is counted. "user": each signed-in user (requests without a user count by IP).
   * "ip": each client IP address. Default "user".
   */
  by?: "user" | "ip";
}

export interface RateLimitConfig {
  /**
   * Where counts are kept. "memory" (default): in this process, for one instance and tests.
   * "database": in the inferlo_rate_limits table of the app's Postgres database, shared by every instance.
   */
  store?: "memory" | "database";
}

/** Counts hits per key in fixed windows. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

const WINDOWS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

export function windowMs(limit: RateLimit): number {
  return WINDOWS[limit.per];
}

/** Check a route's rateLimit option at startup. Raises IL6007. */
export function checkRateLimit(limit: unknown, where: string): void {
  const l = limit as RateLimit;
  const problems: string[] = [];
  if (typeof l !== "object" || l === null) problems.push("it must be an object");
  else {
    if (!Number.isInteger(l.max) || l.max < 1) problems.push("max must be a whole number of at least 1");
    if (!Object.hasOwn(WINDOWS, l.per as string)) problems.push(`per must be one of ${Object.keys(WINDOWS).map((k) => `"${k}"`).join(", ")}`);
    if (l.by !== undefined && l.by !== "user" && l.by !== "ip") problems.push('by must be "user" or "ip"');
  }
  if (problems.length) {
    throw new InferloError("IL6007", `Invalid rateLimit on ${where}: ${problems.join(", ")}.`, {
      fix: 'Use rateLimit: { max: 10, per: "minute", by: "user" } (per: "second" | "minute" | "hour" | "day", by: "user" | "ip").',
    });
  }
}

export function memoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const counts = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, ms) {
      const time = now();
      if (counts.size > 10_000) for (const [k, v] of counts) if (v.resetAt <= time) counts.delete(k);
      let entry = counts.get(key);
      if (!entry || entry.resetAt <= time) {
        entry = { count: 0, resetAt: time + ms };
        counts.set(key, entry);
      }
      entry.count++;
      return { count: entry.count, resetMs: entry.resetAt - time };
    },
  };
}

/** Counts in the inferlo_rate_limits table (created on first use), one row per key, updated atomically. */
export function databaseRateLimitStore(adapter: Adapter): RateLimitStore {
  const sql = adapter.sql?.bind(adapter);
  if (!sql) {
    throw new InferloError("IL6008", `rateLimit store "database" needs a Postgres database, but the app uses the ${adapter.dialect} adapter.`, {
      fix: 'Use postgres() from "@browserlessapi/inferlo/postgres" for createApp({ db }), or rateLimit: { store: "memory" }.',
    });
  }
  let ready: Promise<unknown> | undefined;
  const create = () =>
    sql('CREATE TABLE IF NOT EXISTS "inferlo_rate_limits" ("key" text PRIMARY KEY, "count" integer NOT NULL, "reset_at" timestamptz NOT NULL)').catch(
      // Two instances creating the table at the same moment: the other one won.
      () => sql('SELECT 1 FROM "inferlo_rate_limits" LIMIT 1'),
    );
  return {
    async hit(key, ms) {
      ready ??= create().catch((error) => {
        ready = undefined;
        throw error;
      });
      await ready;
      const rows = await sql(
        `INSERT INTO "inferlo_rate_limits" AS r ("key", "count", "reset_at") VALUES ($1, 1, now() + $2 * interval '1 millisecond')
         ON CONFLICT ("key") DO UPDATE SET
           "count" = CASE WHEN r."reset_at" <= now() THEN 1 ELSE r."count" + 1 END,
           "reset_at" = CASE WHEN r."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE r."reset_at" END
         RETURNING "count", ceil(extract(epoch from ("reset_at" - now())) * 1000)::bigint AS "reset_ms"`,
        [key, ms],
      );
      const row = rows[0] as { count: number | string; reset_ms?: number | string; resetMs?: number | string };
      return { count: Number(row.count), resetMs: Math.max(0, Number(row.reset_ms ?? row.resetMs ?? 0)) };
    },
  };
}

/** Headers for a limited route, and the IL2005 error once the limit is passed. */
export function rateLimitResult(limit: RateLimit, hit: { count: number; resetMs: number }): { headers: Record<string, string>; error?: InferloError } {
  const reset = Math.max(1, Math.ceil(hit.resetMs / 1000));
  const headers: Record<string, string> = {
    "ratelimit-limit": String(limit.max),
    "ratelimit-remaining": String(Math.max(0, limit.max - hit.count)),
    "ratelimit-reset": String(reset),
  };
  if (hit.count <= limit.max) return { headers };
  headers["retry-after"] = String(reset);
  return {
    headers,
    error: new InferloError("IL2005", `Too many requests. Try again in ${reset} second${reset === 1 ? "" : "s"}.`, {
      status: 429,
      fix: `This route allows ${limit.max} request${limit.max === 1 ? "" : "s"} per ${limit.per}. Wait for the Retry-After header's seconds before retrying.`,
    }),
  };
}
