# Models and database

## Models

```ts
import { model, t, type Row } from "@browserlessapi/inferlo";

export const Ticket = model("tickets", {
  title: t.string().min(3).max(200),
  priority: t.enum(["low", "normal", "urgent"]).default("normal"),
  status: t.enum(["open", "closed"]).default("open").index(),
  ownerId: t.ref("users", { onDelete: "cascade" }),
});

type Ticket = Row<typeof Ticket>;
```

- The first argument is the table name and the property on `db` (`db.tickets`). Lowercase with underscores.
- Every model gets `id` (uuid), `createdAt` and `updatedAt`. Do not define them.
- Fields are camelCase in code and snake_case in the database (`ownerId` is `owner_id`).
- `Ticket.create` is the insert schema, `Ticket.update` the update schema, `Ticket.pick(...)` / `Ticket.omit(...)` give route body schemas.

## Register your models once

```ts
// src/models.ts
export const models = [User, Ticket] as const;

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: typeof models;
    user: AppUser;
  }
}
```

After this, `ctx.db` in every handler is fully typed.

## Queries

```ts
await db.tickets.insert({ title: "Down", ownerId: user.id });          // validated, returns the row
await db.tickets.find(id);                                              // row or null
await db.tickets.get(id);                                               // row, or throws IL4001 (404)
await db.tickets.findOne({ ownerId: user.id, status: "open" });
await db.tickets.findMany({
  where: { status: "open", priority: { in: ["normal", "urgent"] }, createdAt: { gte: since } },
  orderBy: { createdAt: "desc" },
  limit: 20,      // default 100, max 1000
  offset: 0,
});
await db.tickets.count({ status: "open" });
await db.tickets.paginate({ where: { status: "open" }, orderBy: { createdAt: "desc" }, cursor, limit: 20 }); // { items, nextCursor }, see Pagination
await db.tickets.update(id, { status: "closed" });                      // validated, throws 404 if missing
await db.tickets.updateMany({ ownerId: user.id }, { status: "closed" });
await db.tickets.delete(id);                                            // true if deleted
await db.tickets.deleteMany({ status: "closed" });                      // a filter is required
```

Where operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `ilike`, `isNull`. A plain value means `eq`; `null` means `isNull: true`; `undefined` is ignored, so optional filters can be passed directly.

Unknown fields or operators raise IL4003 with a "Did you mean" hint.

## Relations

Every `t.ref` field named `<name>Id` is a relation called `<name>`: `ownerId: t.ref("users")` gives `owner`. Load related rows with `include`:

```ts
const tickets = await db.tickets.findMany({ where: { status: "open" }, include: { owner: true } });
tickets[0].owner.name;    // Row<typeof User>, fully typed

const ticket = await db.tickets.get(id, { include: { owner: true, assignee: true } });
ticket.assignee?.name;    // optional or nullable refs give Row | null
```

- `include` works on `findMany`, `findOne(where, { include })`, `find(id, { include })` and `get(id, { include })`.
- Each relation costs **one extra query** for all rows together (`WHERE id IN (...)`), never one query per row.
- Rows keep the id field (`ownerId`) and get the related row under the relation name (`owner`). A missing related row is `null`.
- Ref fields whose name does not end in `Id`, or whose relation name is already a field, are not relations. Unknown names raise IL4023, listing the relations the model has.

### Reverse (has-many) relations

The other direction works too: include the rows that point to this one by their **table name**. If `tickets` has `ownerId: t.ref("users")`, then:

```ts
const users = await db.users.findMany({ include: { tickets: true } });
users[0].tickets;         // Row<typeof Ticket>[], [] when there are none

const team = await db.teams.get(id, { include: { tickets: true } });
```

- One extra query per relation for all rows together (`WHERE owner_id IN (...)`), ordered by `createdAt`, then `id`.
- Every related row is loaded. For large lists, query the other table with `findMany({ where: { ownerId: user.id }, limit })` instead.
- If the other table has **several** ref fields to this model (`ownerId` and `assigneeId`), each is named `<table>By<Name>`: `include: { ticketsByOwner: true, ticketsByAssignee: true }`. The plain table name is then ambiguous and raises IL4023, naming both.
- A reverse name that is already a field or a relation of this model is not available.
- Forward and reverse relations can be combined in one `include`.

## Pagination

`paginate` returns one page and a cursor for the next one. Pass `nextCursor` back as `cursor`; it is `null` on the last page.

```ts
export const listTickets = route
  .get("/tickets", { query: t.object({ limit: t.int().min(1).max(100).default(20), cursor: t.string().max(500).optional() }) })
  .handle(({ query, user, db }) =>
    db.tickets.paginate({ where: { ownerId: user.id }, orderBy: { createdAt: "desc" }, limit: query.limit, cursor: query.cursor }),
  );
// { "items": [...], "nextCursor": "eyJmIjoiY3JlYXRlZEF0Ii..." }
```

- **Stable pages.** Pagination is by key (the last row's value and id), not by offset, so pages never skip or repeat rows when rows are added or deleted elsewhere in the list, and deep pages are as fast as the first.
- **Order** by one field: `orderBy: { createdAt: "desc" }` (the default is `{ createdAt: "asc" }`). Rows with the same value are ordered by `id`. The field must be required (not `.optional()` without a default, not `.nullable()`) and not `json`, `array` or `object`; otherwise IL4025. More than one field, or `offset`, also raises IL4025.
- `where`, `limit` (default 100, maximum 1000) and `include` work as in `findMany`. A page costs one query, or two after the first page when ordering by a field other than `id`, plus one per included relation.
- **Cursors** are opaque strings. Pass them back unchanged with the same `orderBy`. A cursor that was changed, is not from `paginate`, or was made for another order raises IL4024 with status 400, so a bad `?cursor=` from a client is a 400 response. Cursors are not secret: they contain the last row's id and order value, and `where` still applies to every page.
- For numbered pages ("page 3 of 12"), use `findMany({ limit, offset })` with `count(where)`.

## Multi-tenancy

In an app used by many organisations (workspaces, customers), a table whose rows belong to one organisation is **tenant-scoped**: pass `{ tenant: true }` as the third argument of `model`.

```ts
export const Project = model("projects", { name: t.string().max(100), slug: t.string().unique() }, { tenant: true });
```

Every row then has a `tenantId` (column `tenant_id`, indexed), and `ctx.db` in routes works only with the signed-in user's tenant:

- **Reads** (`find`, `get`, `findOne`, `findMany`, `paginate`, `count`) only see the tenant's rows. Another tenant's id is "not found" (404 with `get`).
- **Inserts** are stamped with the tenant. `tenantId` is never accepted as input (422), so a client cannot choose it.
- **Updates and deletes** (by id or with a `where`) only touch the tenant's rows.
- **Unique fields are unique per tenant**: two organisations can both have the slug `support` (the Postgres index is `(tenant_id, slug)`).
- **References stay in the tenant**: a `t.ref` field pointing at another tenant-scoped table must name a row of the same tenant (422 otherwise), and `include` loads only the tenant's rows.
- `$transaction` keeps the tenant. Tables that are not tenant-scoped (users, plans) work as before.

There is no filter to forget: handlers write `db.projects.findMany()` and get only their organisation's projects.

**Where the tenant comes from.** By default it is `user.tenantId`, the user object your auth returns. Name another field with the `tenant` option of `bearer`, `sessions` or `auth`:

```ts
auth: bearer(verifyKey, { tenant: (user) => user.orgId }),
```

A tenant id is a non-empty string of at most 200 characters; anything else raises IL4027. A request without a user, or with a user who has no tenant (`null` or `undefined`), cannot use tenant-scoped tables: the call raises IL4027 (a 500, because the route should not reach it), and other tables work.

**Jobs** get the tenant of the request (or job) that queued them, also through events: their `ctx.db` is scoped to it, so a job queued from a route needs no tenant id in its input (see [jobs](jobs.md#enqueue)). `app.jobs.enqueue(job, input, { tenantId })` and `app.events.publish(event, payload, { tenantId })` set it elsewhere.

**Rate limits, cached responses and the audit log** follow the tenant too: `rateLimit: { by: "tenant" }` counts all users of a tenant together (see [rate limiting](routes.md#rate-limiting)), the route option `cache: { by: "tenant" }` shares a cached response between them (see [caching](caching.md)), and `ctx.audit` records the tenant with each entry (see [audit log](auth.md#audit-log)).

**Outside requests and jobs** (`app.db`, scripts, tests, the `db` passed to `auth.resolve`) there is no current tenant, so tenant-scoped tables raise IL4027 until you say which tenant:

```ts
await app.db.$tenant("acme").projects.insert({ name: "Apollo", slug: "apollo" });
const all = await app.db.$allTenants().projects.findMany(); // reports and admin tools: every tenant's rows
```

`$allTenants()` reads, updates and deletes across tenants and cannot insert (a new row needs `$tenant(id)`). `db.$tenantId` is the client's tenant id, `"all"`, or `null`.

Adding `{ tenant: true }` to a table that already has rows adds a required `tenant_id` column and changes its unique indexes: write that migration yourself (add the column, fill it in, then make it `NOT NULL`).

## Adapters

```ts
import { memory } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";

createApp({ db: memory() });                                  // tests and prototypes
createApp({ db: postgres({ url: env("DATABASE_URL") }) });    // production (npm install pg)
```

## Schema changes

```bash
inferlo db push --dry-run   # show the SQL
inferlo db push             # create missing tables, columns and indexes
```

`db push` only adds things; it never drops or renames columns. New columns on existing tables should be `.optional()` or have a `.default()`. Use it for development and prototypes; use migrations in production.

## Migrations

```bash
inferlo db migrate add_due_dates   # write migrations/0002_add_due_dates.sql for your model changes
inferlo db migrate --dry-run       # print the SQL without writing anything
inferlo db migrate drop_color --allow-drop   # include drops of tables, columns and indexes (deletes data)
inferlo db migrate require_body --allow-change   # include type, default, required/optional and enum value changes
inferlo db migrate --apply         # run pending migration files against DATABASE_URL
```

- `inferlo db migrate [name]` compares your models with `migrations/snapshot.json` (your models as of the last generated migration), writes the SQL for the difference to the next numbered file and updates the snapshot. With no changes it writes nothing. Commit both files.
- Review the generated SQL before applying it. You may edit a file until it has been applied anywhere; after that, add a new migration instead.
- `--apply` runs every file not yet recorded in the `inferlo_migrations` table, in file name order, each in its own transaction, and records it with a SHA-256 checksum of its SQL. It is safe to run on every deploy and from several instances at once. Do not put `BEGIN` or `COMMIT` in migration files.
- If a file that was already applied has been edited since, `--apply` does not run it again: it prints warning IL4018 naming the file (and lists it in `edited` with `--json`), and still applies the pending files. Restore the applied SQL (for example with `git checkout`) and put the change in a new migration. Line ending changes (CRLF and LF) do not count as edits. Migrations applied with Inferlo 0.2 get their checksum recorded from the current file on the next `--apply`.
- Generated statements use `IF NOT EXISTS`, so the first migration also works on a database created with `db push`.
- New tables, columns and indexes are generated directly. A new required column on an existing table raises IL4014: give it a fixed `.default(value)` or make it `.optional()`.
- Removing a model, field, `.unique()` or `.index()` drops data, so it raises IL4017 and nothing is written, unless you pass `--allow-drop`. Then the file gets `DROP INDEX`, `ALTER TABLE ... DROP COLUMN` and `DROP TABLE` statements (without `CASCADE`) and a warning comment, and `--json` output lists them in `drops`. Back up before applying it.
- Changing a field's default, making it required or optional, or changing an enum's values raises IL4019 and nothing is written, unless you pass `--allow-change`. Then the file gets `ALTER TABLE ... ALTER COLUMN ...` with `SET DEFAULT`, `DROP DEFAULT`, `SET NOT NULL` or `DROP NOT NULL`, and `--json` output lists the changes in `changes`, for example `change column notes.body (optional -> required, default none -> '')`. A function default (`.default(() => ...)`) is filled in by Inferlo, not the database, so it counts as no default (`DROP DEFAULT`).
- Making a field required: if it has a fixed `.default(value)`, rows that are NULL get that value first (`UPDATE ... WHERE ... IS NULL`), as for a new required column. Without a default, `--apply` fails with IL4020 if any row is still NULL, and nothing from that migration is kept. Add an `UPDATE` that fills them before the `SET NOT NULL` (only in a file that has not been applied anywhere), or give the field a default.
- Changing an enum's values (adding or removing one, or turning a text field into an enum or back) also needs `--allow-change`. The file replaces the column's CHECK constraint: `ALTER TABLE "posts" DROP CONSTRAINT "posts_kind_check"`, then `ALTER TABLE "posts" ADD CONSTRAINT "posts_kind_check" CHECK ("kind" IN ('note', 'page'))`, using the name Postgres gave it. Adding a value always works. If rows still use a removed value, `--apply` fails with IL4021 and nothing from that migration is kept: in a file that has not been applied anywhere, add `UPDATE "posts" SET "kind" = 'page' WHERE "kind" = 'article';` before the `ADD CONSTRAINT`, or keep the value.
- Changing a field's type (for example `t.string().max(120)` to `.max(200)`, `t.text()` to `t.int()`, or `t.int()` to `t.number()`) also needs `--allow-change`. The file gets `ALTER TABLE "posts" ALTER COLUMN "title" TYPE varchar(200)`, with a `USING` clause when Postgres needs one: other types go through their text (`USING "views"::text::integer`), jsonb values use their JSON text (`USING ("meta" #>> '{}')::integer`), and a field becoming `t.json()` uses `to_jsonb(...)`, so text becomes a JSON string. A fixed default is dropped before the type change and set again after it. Conversions are strict: a value that does not fit (text that is not a number, `2.5` going to `integer`, text longer than the new `varchar(n)`) is never cut, rounded or set to NULL; `--apply` fails with IL4022 and nothing from that migration is kept. In a file that has not been applied anywhere, add an `UPDATE` before the `TYPE` statement that fixes those values, or write your own `USING` expression.
- Renames and reference changes are not generated yet: they raise IL4013 and nothing is written. The message says what changed in each column, for example `change column posts.author_id (reference authors on delete cascade -> authors on delete restrict)`, and `details.columns` lists the same as `{ table, column, changes }`. A rename looks like a drop plus an add; do not use `--allow-drop` for a rename, or the column's data is lost.
- `snapshot.json` describes each column as `{ type, notNull, default?, enum?, references?, primaryKey? }` (format `"inferlo": 2`). Snapshots written by Inferlo 0.2.0 (`"inferlo": 1`, each column as SQL text) are read as they are and saved in the new format with the next generated migration. Do not edit the snapshot by hand; an invalid one raises IL4015.

To apply migrations from code, for example at startup in a serverless function:

```ts
import { applyMigrations } from "@browserlessapi/inferlo";

await applyMigrations(app.db, [{ name: "0001_init", sql: initSql }]);   // returns the names it applied

// Applied migrations whose SQL changed since are not run again; onEdited gets their names (IL4018).
await applyMigrations(app.db, migrations, { onEdited: (names) => console.warn("Edited after apply:", names) });
```

To generate SQL from code, use `planMigration(models, snapshot, { allowDrop, allowChange })`. It returns `{ statements, snapshot, drops, changes }`:

```ts
import { planMigration } from "@browserlessapi/inferlo";

const plan = planMigration(models, previousSnapshot, { allowDrop: true });   // allowDrop and allowChange default to false
```

## Transactions and raw SQL (Postgres)

```ts
await db.$transaction(async (tx) => {
  const order = await tx.orders.insert({ ... });
  await tx.order_items.insertMany(items.map((i) => ({ ...i, orderId: order.id })));
});

await db.$sql("select count(*) from tickets where owner_id = $1", [user.id]);   // always use $1 placeholders
```
