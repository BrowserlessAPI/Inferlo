/**
 * Application cache: ctx.cache in routes and jobs, app.cache everywhere else.
 *
 *   const stats = await cache.getOrSet("stats:daily", { ttlMs: 60_000, tags: ["tickets"] }, () => computeStats(db));
 *   await cache.invalidate("tickets"); // after a ticket changes
 *
 * Values are stored as JSON, in memory (one process, the default) or in the app's Postgres database (shared by
 * every instance), chosen with createApp({ cache: { store } }).
 */
import type { Adapter } from "./db/types.ts";
import { InferloError } from "./errors.ts";

export interface CacheConfig {
  /**
   * Where entries are kept. "memory" (default): in this process, for one instance and tests.
   * "database": in the inferlo_cache table of the app's Postgres database, shared by every instance.
   * "redis": in the Redis of createApp({ redis }), shared by every instance.
   */
  store?: "memory" | "database" | "redis";
  /** Most entries the memory store keeps; the least recently used go first. Default 10000. */
  maxEntries?: number;
}

export interface CacheSetOptions {
  /** How long the entry is kept, in milliseconds (at least 1, at most 365 days). */
  ttlMs: number;
  /** Tags for cache.invalidate(tag), for example ["tickets", `user:${user.id}`]. */
  tags?: readonly string[];
}

export interface Cache {
  /** Where entries are kept: "memory", "database" or "redis". */
  readonly store: "memory" | "database" | "redis";
  /** The cached value, or undefined when there is none or it expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Store a JSON value (not undefined; use null for "nothing") for ttlMs. Dates are stored as ISO strings. */
  set(key: string, value: unknown, options: CacheSetOptions): Promise<void>;
  /**
   * The cached value, or else the result of compute(), stored for ttlMs. Concurrent calls for the same key in this
   * process share one compute() call. Errors from compute() are thrown and nothing is stored.
   */
  getOrSet<T>(key: string, options: CacheSetOptions, compute: () => T | Promise<T>): Promise<T>;
  /** Remove one entry. */
  delete(key: string): Promise<void>;
  /** Remove every entry stored with any of these tags. */
  invalidate(tags: string | readonly string[]): Promise<void>;
  /** Remove every entry. */
  clear(): Promise<void>;
}

/** Where a Cache keeps its entries, as JSON text. */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, json: string, ttlMs: number, tags: readonly string[]): Promise<void>;
  delete(key: string): Promise<void>;
  invalidate(tags: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

const MAX_TTL_MS = 365 * 86_400_000;
const bad = (message: string, fix: string) => new InferloError("IL6028", message, { fix });

/** Check createApp({ cache }) at startup. Raises IL6028. */
export function resolveCacheConfig(config: unknown): { store: "memory" | "database" | "redis"; maxEntries: number } {
  if (config === undefined) return { store: "memory", maxEntries: 10_000 };
  const c = config as CacheConfig;
  const fix = 'Use createApp({ cache: { store: "memory" } }) (the default, with an optional maxEntries), { store: "database" } or { store: "redis" }.';
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw bad("createApp({ cache }) must be an object.", fix);
  for (const key of Object.keys(c)) if (key !== "store" && key !== "maxEntries") throw bad(`Unknown cache option "${key}".`, fix);
  const store = c.store ?? "memory";
  if (store !== "memory" && store !== "database" && store !== "redis") throw bad(`Invalid cache store ${JSON.stringify(store)}.`, fix);
  const maxEntries = c.maxEntries ?? 10_000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw bad("cache maxEntries must be a whole number of at least 1.", fix);
  if (store !== "memory" && c.maxEntries !== undefined) throw bad("cache maxEntries only applies to the memory store.", `Remove maxEntries from createApp({ cache: { store: "${store}" } }).`);
  return { store, maxEntries };
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw bad(`A cache key must be a string of 1 to 512 characters, got ${typeof key === "string" ? `${key.length} characters` : typeof key}.`, 'Use a short, stable key such as `ticket:${id}`.');
  }
}

function checkTags(tags: unknown): readonly string[] {
  const list = typeof tags === "string" ? [tags] : tags;
  if (!Array.isArray(list) || list.some((t) => typeof t !== "string" || t.length === 0 || t.length > 256)) {
    throw bad("Cache tags must be strings of 1 to 256 characters.", 'Use tags: ["tickets", `user:${user.id}`] and cache.invalidate("tickets").');
  }
  return list as readonly string[];
}

function checkOptions(options: unknown): { ttlMs: number; tags: readonly string[] } {
  const o = options as CacheSetOptions;
  if (typeof o !== "object" || o === null || !Number.isInteger(o.ttlMs) || o.ttlMs < 1 || o.ttlMs > MAX_TTL_MS) {
    throw bad("Cache entries need ttlMs, a whole number of milliseconds from 1 to 365 days.", 'Pass { ttlMs: 60_000 } (one minute), optionally with tags: ["tickets"].');
  }
  return { ttlMs: o.ttlMs, tags: o.tags === undefined ? [] : checkTags(o.tags) };
}

function toJSON(key: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw bad(`The value for cache key "${key}" cannot be stored as JSON: ${(error as Error).message}`, "Cache plain objects, arrays, strings, numbers, booleans and null.");
  }
  if (json === undefined) throw bad(`The value for cache key "${key}" is ${value === undefined ? "undefined" : typeof value}, which cannot be cached.`, "Cache null for \"nothing\", or a plain JSON value.");
  return json;
}

/** A Cache over a store: checks keys, options and values, stores JSON, shares concurrent getOrSet calls. */
export function createCache(store: CacheStore, name: "memory" | "database" | "redis"): Cache {
  const running = new Map<string, Promise<unknown>>();
  const cache: Cache = {
    store: name,
    async get<T>(key: string) {
      checkKey(key);
      const json = await store.get(key);
      return json === undefined ? undefined : (JSON.parse(json) as T);
    },
    async set(key, value, options) {
      checkKey(key);
      const { ttlMs, tags } = checkOptions(options);
      await store.set(key, toJSON(key, value), ttlMs, tags);
    },
    async getOrSet<T>(key: string, options: CacheSetOptions, compute: () => T | Promise<T>): Promise<T> {
      checkKey(key);
      const { ttlMs, tags } = checkOptions(options);
      if (typeof compute !== "function") throw bad("cache.getOrSet needs a function that computes the value.", "Use cache.getOrSet(key, { ttlMs }, () => compute()).");
      const pending = running.get(key);
      if (pending) return pending as Promise<T>;
      const work = (async () => {
        const json = await store.get(key);
        if (json !== undefined) return JSON.parse(json) as T;
        const value = await compute();
        const text = toJSON(key, value);
        await store.set(key, text, ttlMs, tags);
        // Callers get the stored form, so a cache hit and a miss return the same thing (dates as strings).
        return JSON.parse(text) as T;
      })();
      running.set(key, work);
      try {
        return await work;
      } finally {
        running.delete(key);
      }
    },
    async delete(key) {
      checkKey(key);
      await store.delete(key);
    },
    async invalidate(tags) {
      const list = checkTags(tags);
      if (list.length) await store.invalidate(list);
    },
    async clear() {
      await store.clear();
    },
  };
  return Object.freeze(cache);
}

/** Entries in this process, least recently used removed first once maxEntries is reached. */
export function memoryCacheStore(maxEntries = 10_000, now: () => number = Date.now): CacheStore {
  const entries = new Map<string, { json: string; expiresAt: number; tags: readonly string[] }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now()) return undefined;
      entries.set(key, entry); // most recently used last
      return entry.json;
    },
    async set(key, json, ttlMs, tags) {
      entries.delete(key);
      entries.set(key, { json, expiresAt: now() + ttlMs, tags });
      if (entries.size > maxEntries) {
        const time = now();
        for (const [k, v] of entries) if (v.expiresAt <= time) entries.delete(k);
        for (const k of entries.keys()) {
          if (entries.size <= maxEntries) break;
          entries.delete(k);
        }
      }
    },
    async delete(key) {
      entries.delete(key);
    },
    async invalidate(tags) {
      for (const [k, v] of entries) if (v.tags.some((t) => tags.includes(t))) entries.delete(k);
    },
    async clear() {
      entries.clear();
    },
  };
}

/** Entries in the inferlo_cache table (created on first use), shared by every instance of the app. */
export function databaseCacheStore(adapter: Adapter): CacheStore {
  const sql = adapter.sql?.bind(adapter);
  if (!sql) {
    throw bad(`cache store "database" needs a Postgres database, but the app uses the ${adapter.dialect} adapter.`, 'Use postgres() from "@browserlessapi/inferlo/postgres" for createApp({ db }), or cache: { store: "memory" }.');
  }
  let ready: Promise<unknown> | undefined;
  const create = () =>
    sql('CREATE TABLE IF NOT EXISTS "inferlo_cache" ("key" text PRIMARY KEY, "value" text NOT NULL, "tags" text[] NOT NULL DEFAULT \'{}\', "expires_at" timestamptz NOT NULL)')
      .then(() => sql('CREATE INDEX IF NOT EXISTS "inferlo_cache_tags" ON "inferlo_cache" USING gin ("tags")'))
      .catch(
        // Two instances creating the table at the same moment: the other one won.
        () => sql('SELECT 1 FROM "inferlo_cache" LIMIT 1'),
      );
  const query = async (text: string, params: unknown[] = []) => {
    ready ??= create().catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return sql(text, params);
  };
  let writes = 0;
  return {
    async get(key) {
      const rows = await query('SELECT "value" FROM "inferlo_cache" WHERE "key" = $1 AND "expires_at" > now()', [key]);
      return rows.length ? String((rows[0] as { value: string }).value) : undefined;
    },
    async set(key, json, ttlMs, tags) {
      await query(
        `INSERT INTO "inferlo_cache" ("key", "value", "tags", "expires_at") VALUES ($1, $2, $3::text[], now() + $4 * interval '1 millisecond')
         ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "tags" = EXCLUDED."tags", "expires_at" = EXCLUDED."expires_at"`,
        [key, json, [...tags], ttlMs],
      );
      // Expired rows are never read; remove them now and then so the table does not grow without bound.
      if (++writes % 100 === 0) await query('DELETE FROM "inferlo_cache" WHERE "expires_at" <= now()');
    },
    async delete(key) {
      await query('DELETE FROM "inferlo_cache" WHERE "key" = $1', [key]);
    },
    async invalidate(tags) {
      await query('DELETE FROM "inferlo_cache" WHERE "tags" && $1::text[]', [[...tags]]);
    },
    async clear() {
      await query('DELETE FROM "inferlo_cache"');
    },
  };
}

/** The route option cache: route.get("/tickets/stats", { cache: { ttlMs: 60_000, tags: ["tickets"] } }). */
export interface RouteCache {
  /** How long a response is kept, in milliseconds (at least 1, at most 365 days). */
  ttlMs: number;
  /**
   * Who shares a cached response. "user" (default): each signed-in user gets their own (requests without a user
   * share one). "tenant": the users of one tenant (organisation) share one, in multi-tenant apps (users without a
   * tenant get their own). "public": every caller gets the same response; only for data that does not depend on
   * the user.
   */
  by?: "user" | "tenant" | "public";
  /** Tags for ctx.cache.invalidate(tag), so a change removes the cached responses at once. */
  tags?: readonly string[];
}

/** Check a route's cache option at startup. Raises IL6028. */
export function checkRouteCache(option: unknown, method: string, where: string): void {
  const o = option as RouteCache;
  const problems: string[] = [];
  if (method !== "GET") problems.push("only GET routes can be cached");
  if (typeof o !== "object" || o === null) problems.push("it must be an object");
  else {
    for (const key of Object.keys(o)) if (key !== "ttlMs" && key !== "by" && key !== "tags") problems.push(`unknown option "${key}"`);
    if (!Number.isInteger(o.ttlMs) || o.ttlMs < 1 || o.ttlMs > MAX_TTL_MS) problems.push("ttlMs must be a whole number of milliseconds from 1 to 365 days");
    if (o.by !== undefined && o.by !== "user" && o.by !== "tenant" && o.by !== "public") problems.push('by must be "user", "tenant" or "public"');
    if (o.tags !== undefined && (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string" || t.length === 0 || t.length > 256))) problems.push("tags must be strings of 1 to 256 characters");
  }
  if (problems.length) {
    throw bad(`Invalid cache option on ${where}: ${problems.join(", ")}.`, 'Use route.get(path, { cache: { ttlMs: 60_000, by: "user", tags: ["tickets"] } }).');
  }
}

/** A cached route response: the handler's JSON result and the headers it set itself. */
export interface CachedResponse {
  body: unknown;
  headers: [string, string][];
  etag: string;
}

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(text: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The cache key of one request to a cached route: the route, who shares the response (the user, the tenant or
 * everyone) and the full URL path and
 * query (sorted, so ?a=1&b=2 and ?b=2&a=1 share an entry), hashed to a short key.
 */
export async function routeCacheKey(method: string, path: string, option: RouteCache, userId: string | undefined, url: URL, tenantId?: string | null): Promise<string> {
  const by = option.by ?? "user";
  const who = by === "public" ? "public" : by === "tenant" && tenantId ? `tenant:${tenantId}` : userId === undefined ? "anonymous" : `user:${userId}`;
  const query = [...url.searchParams].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return `route:${await sha256(JSON.stringify([method, path, who, url.pathname, query]))}`;
}

/** A weak ETag for a JSON body. */
export async function etagFor(json: string): Promise<string> {
  return `W/"${(await sha256(json)).slice(0, 27)}"`;
}

/** True when an If-None-Match header lists the ETag (or is *). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}
