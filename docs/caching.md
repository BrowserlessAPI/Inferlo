# Caching

Every app has a cache for results that are slow or expensive to compute: reports, counts, responses from other services, AI answers that do not change often. It is `ctx.cache` in routes and jobs and `app.cache` everywhere else (scripts, tests, server startup), all the same cache.

```ts
import { route } from "@browserlessapi/inferlo";

export const ticketStats = route.get("/tickets/stats", { summary: "Ticket counts by status" }).handle(({ db, cache }) =>
  cache.getOrSet("tickets:stats", { ttlMs: 60_000, tags: ["tickets"] }, async () => {
    const all = await db.tickets.findMany({});
    return { open: all.filter((t) => t.status === "open").length, total: all.length };
  }),
);

export const closeTicket = route.post("/tickets/:id/close", { params: IdParams }).handle(async ({ db, cache, params }) => {
  const ticket = await db.tickets.update(params.id, { status: "closed" });
  await cache.invalidate("tickets"); // every entry tagged "tickets" is removed
  return ticket;
});
```

## The API

| Call | What it does |
|---|---|
| `await cache.getOrSet(key, { ttlMs, tags }, compute)` | The cached value, or else the result of `compute()`, stored for `ttlMs`. Concurrent calls for the same key in one process share one `compute()` call. When `compute()` throws, nothing is stored and the error is thrown. |
| `await cache.get(key)` | The cached value, or `undefined` when there is none or it expired. `cache.get<Stats>(key)` types the result. |
| `await cache.set(key, value, { ttlMs, tags })` | Store a value for `ttlMs` milliseconds, replacing any entry with the same key. |
| `await cache.delete(key)` | Remove one entry. |
| `await cache.invalidate("tickets")` or `invalidate(["tickets", "users"])` | Remove every entry stored with any of these tags. |
| `await cache.clear()` | Remove every entry. |
| `cache.store` | `"memory"` or `"database"`. |

Prefer `getOrSet`: it is one call, and it cannot forget to store the result.

- **Every entry has a time to live.** `ttlMs` is required, a whole number of milliseconds from 1 to 365 days. There is no entry that lives forever, so stale data always goes away on its own.
- **Tags invalidate groups of entries.** Tag entries with what they depend on (`"tickets"`, `` `user:${user.id}` ``) and call `invalidate` with that tag after a change. This is how to keep cached data correct when the data changes before the time to live is over.
- **Values are stored as JSON.** Plain objects, arrays, strings, numbers, booleans and `null`. Dates come back as ISO strings, also from `getOrSet` on the first call, so a hit and a miss return the same thing. `undefined`, functions and `BigInt` cannot be cached (IL6028); cache `null` for "nothing". The memory store keeps JSON too, so changing an object you stored or got never changes the cached entry.
- **Keys** are strings of 1 to 512 characters. Build them from what the value depends on: `` `tickets:stats` ``, `` `user:${user.id}:dashboard` ``. A value that differs per user must have the user in its key, so one user never sees another user's data.

## Stores

```ts
createApp({ cache: { store: "memory" } });   // default
createApp({ cache: { store: "database" }, db: postgres({ url: settings.DATABASE_URL }) });
```

- `"memory"` (default): entries live in the process. Fast and fine for one instance and for tests, but each instance has its own entries, and `invalidate` only reaches the instance that calls it. It keeps at most `maxEntries` entries (default 10000; `{ store: "memory", maxEntries: 50_000 }`) and removes the least recently used first.
- `"database"`: entries live in the `inferlo_cache` table of the app's Postgres database (created on first use), so every instance shares them and `invalidate` and `delete` reach all of them. Expired entries are never returned and are removed from time to time. Apps that share one database share this table, so give their keys and tags a prefix. It needs `postgres()` as the database; with another adapter `createApp` raises IL6028.

`inferlo describe` and `app.describe().cache` show which store an app uses.

A Redis store is planned (see the roadmap). Until then, apps with several instances that need a shared cache use `"database"`.

## In jobs and tests

```ts
export const refreshStats = job("refresh-stats", { input: t.object({}) }).handle(async ({ cache }) => {
  await cache.invalidate("tickets");
});
```

In tests, `app.cache` is the same cache the routes use: check what a route stored with `await app.cache.get(key)`, or start from a clean cache with `await app.cache.clear()`.
