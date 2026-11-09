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

## Vector search

Store embeddings in a `t.vector(dimensions)` field and find the rows closest to a question with `db.<table>.search`:

```ts
// src/models.ts
export const Doc = model("docs", {
  title: t.string().max(200),
  body: t.text(),
  ownerId: t.ref("users"),
  embedding: t.vector(1536).optional().index(), // OpenAI text-embedding-3-small has 1536 dimensions
});

// Store the embedding with the row.
const { embeddings } = await ai.embed({ model: "embed", input: body.body, for: user.id });
await db.docs.insert({ ...body, ownerId: user.id, embedding: embeddings[0] });

// The five rows closest to the question, closest first.
const { embeddings: [question] } = await ai.embed({ model: "embed", input: query.q, for: user.id });
const hits = await db.docs.search({ vector: question!, where: { ownerId: user.id }, limit: 5 });
// [{ row: { id, title, body, ... }, distance: 0.12 }, ...]
```

- **Distance** is cosine distance (pgvector's `<=>`): 0 for the same direction, 1 for unrelated, 2 for the opposite. Each result is `{ row, distance }`, closest first. Rows whose vector is `null` are left out.
- **Options.** `vector` (exactly the field's number of dimensions), `where` (as in `findMany`), `limit` (default 10, maximum 1000), and `field` when the model has more than one `t.vector()` field. A wrong field or vector raises IL4030. Tenant-scoped tables only search the tenant's rows.
- **Validation.** Inserts and updates accept exactly `dimensions` finite numbers (IL1001 with `invalid_dimensions` otherwise). `t.vector()` takes 1 to 16000 dimensions (IL1005). Use the same embedding model for the stored rows and the question.
- **Postgres** stores the field as pgvector's `vector(dimensions)` column. `inferlo db push` and `inferlo db migrate` run `CREATE EXTENSION IF NOT EXISTS vector` before the first vector column, so the server needs pgvector installed (managed Postgres such as Amazon RDS, Google Cloud SQL, Azure, Supabase and Neon include it) and the database user needs permission to create the extension (or create it once yourself). `.index()` adds an HNSW index for cosine distance, which keeps searches fast on large tables (at most 2000 dimensions for an index). Tested with pgvector 0.5.0 (the first release with HNSW indexes) and the latest release.
- **memory()** searches by computing the distances in JavaScript, so tests need no database.

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
createApp({ db: sqlite({ path: "./data/app.db" }) });         // one server, local tools (import from "@browserlessapi/inferlo/sqlite")
createApp({ db: mysql({ url: env("DATABASE_URL") }) });       // MySQL (npm install mysql2; import from "@browserlessapi/inferlo/mysql")
```

### MySQL

`mysql({ url })` from `@browserlessapi/inferlo/mysql` stores the data in MySQL 8.4 or newer, through the `mysql2` driver (`npm install mysql2`, an optional peer dependency).

```ts
import { mysql } from "@browserlessapi/inferlo/mysql";

createApp({ db: mysql({ url: settings.DATABASE_URL }) });   // mysql://user:pass@host:3306/app
createApp({ db: mysql({ pool }) });                        // a mysql2/promise pool you created, with timezone: "Z"
```

- Options: `url` (`mysql://...`) or `pool`, `max` (pool size, default 10) and `debug`. Invalid options are IL4036; without `mysql2` installed, the first query is IL4010.
- Models, queries, relations, pagination, multi-tenancy, audit logs, `$transaction`, `$sync` (`inferlo db push`), `$sql` (with `?` placeholders) and vector search (compared in JavaScript) work as on Postgres, with the same types coming back and the same errors (IL4004, IL4011, IL4012).
- Tables are created with `utf8mb4` and the binary collation `utf8mb4_bin`, so `=`, unique values and `like` are case-sensitive, as on Postgres; `ilike` compares lower-cased values. Dates are `DATETIME(3)` in UTC (millisecond precision), booleans `BOOLEAN`, JSON fields MySQL's `JSON`, ids `CHAR(36)`.
- Strings that are `.unique()` or `.index()` need a length in MySQL: their `.max()`, else `VARCHAR(255)`. Give them a `.max()` when values can be longer. Other strings without `.max()` are `TEXT`, `t.text()` is `MEDIUMTEXT`.
- MySQL has no `RETURNING`: inserts and updates read the rows back by id (an update locks and reads the matching ids first, in a transaction).
- Tables are created and extended with `inferlo db push`, or with migration files: see [Migrations on MySQL](#migrations-on-mysql). `db.$pgClient()` is IL4028.
- The `"database"` stores work on MySQL: `jobQueue: { store: "database" }` keeps jobs in `inferlo_jobs` (due jobs claimed with `FOR UPDATE SKIP LOCKED`, so each runs on one instance), `cache: { store: "database" }` entries in `inferlo_cache` (tags in a JSON array with a multi-valued index) and `rateLimit: { store: "database" }` counts in `inferlo_rate_limits`, each created on first use, with times in UTC. A `mysql({ pool })` you create needs `timezone: "Z"` for them too.

### SQLite

`sqlite({ path })` from `@browserlessapi/inferlo/sqlite` keeps the data in one file, using the SQLite built into the runtime (`node:sqlite` on Node.js 22.13 and later, Bun and Deno), so there is nothing to install. It suits small apps on one server, desktop and command-line tools, and tests that need real SQL; use Postgres when several instances share the database.

```ts
import { sqlite } from "@browserlessapi/inferlo/sqlite";

createApp({ db: sqlite({ path: env("SQLITE_PATH", { default: "./data/app.db" }) }) });
createApp({ db: sqlite() });   // a database in memory, gone when the process ends: tests
```

- Options: `path` (default `":memory:"`; the file is created when missing, its directory must exist), `busyTimeoutMs` (default 5000: how long to wait when another process is writing the file) and `debug`. Unknown options are IL4033.
- Models, queries, relations, pagination, multi-tenancy, audit logs, `$transaction`, `$sync` (`inferlo db push`) and `$sql` work as on Postgres. Tables are created with `inferlo db push` (or `await db.$sync()` at startup); migration files are PostgreSQL or MySQL SQL, so `inferlo db migrate` refuses SQLite with IL4035.
- Values: strings, ids, enums and dates are text (dates as ISO 8601 in UTC, so they sort in time order), `t.int()` and booleans are integers, `t.number()` is a real number, and JSON, arrays, objects and vectors are JSON text. Rows come back with the same types as on Postgres (`Date`, `boolean`, parsed JSON).
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`), files use write-ahead logging, and unique, foreign key and missing-table errors are IL4004, IL4011 and IL4012, as on Postgres.
- `like` is case-sensitive, as on Postgres; `ilike` ignores case for ASCII letters only.
- `db.<table>.search()` compares vectors in JavaScript (SQLite has no vector index), which is fine for thousands of rows, not millions.
- SQLite has one connection. A `$transaction` holds it until it ends, and queries from outside the transaction wait for it: inside `$transaction`, always use `tx`, never the outer `db`, or the query waits for the transaction that waits for it.
- Postgres-only features say so at startup: `jobQueue`, `cache` and `rateLimit` stores `"database"` (use `"memory"` or Redis), `db.$pgClient()` (IL4028) and migration files (IL4035).
- `$sql` uses `?` placeholders: `await db.$sql("select count(*) as n from tickets where owner_id = ?", [user.id])`.

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
inferlo db migrate require_body --allow-change   # include type, default, required/optional, enum value and reference changes
inferlo db migrate colour --rename notes.color=notes.colour   # a renamed column (or --rename notes=memos for a table)
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
- Changing a reference (`t.ref("authors", { onDelete: "cascade" })` to `{ onDelete: "restrict" }`, a reference to another table, or a field that becomes a reference or stops being one) also needs `--allow-change`; without it, IL4019 says what changed, for example `change column posts.author_id (reference authors on delete cascade -> authors on delete restrict)`. The file replaces the column's foreign key constraint, using the name Postgres gave it: `ALTER TABLE "posts" DROP CONSTRAINT "posts_author_id_fkey"`, then `ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT`. A new table the reference points at is created first. Postgres checks every existing row when the constraint is added: if rows hold ids the referenced table does not have (usually after pointing the reference at another table), `--apply` fails with IL4031 and nothing from that migration is kept. In a file that has not been applied anywhere, add an `UPDATE` (for example `UPDATE "posts" SET "author_id" = NULL WHERE "author_id" NOT IN (SELECT "id" FROM "orgs")`) or a `DELETE` before the `ADD CONSTRAINT`.
- A renamed table or column looks like a drop plus an add, so Inferlo never guesses: without `--rename`, IL4017 refuses the drop and its fix names the `--rename` to use when a table lost one column and gained one (or one table was replaced by another). Name each rename as `old=new`, with the old names on the left and your models' names on the right: `--rename notes.color=notes.colour` for a column (field or column names), `--rename notes=memos` for a table, and both together as `--rename notes=memos --rename notes.color=memos.colour`. The file renames the table (`ALTER TABLE "notes" RENAME TO "memos"`) and columns (`ALTER TABLE "memos" RENAME COLUMN "color" TO "colour"`), keeping every row, then the indexes and the enum CHECK and foreign key constraints named after them (`ALTER INDEX "notes_color_idx" RENAME TO "memos_colour_idx"`), so later migrations find them; foreign keys in other tables follow a renamed table. A renamed column whose type or default also changed needs `--allow-change` too. Invalid renames (a name that is not in the snapshot or the models, a column moved to another table) raise IL4032. Deploy the code that uses the new names together with the migration. `--json` output lists them in `renames`, for example `rename column notes.color -> notes.colour`.
- Do not use `--allow-drop` for a rename, or the data is lost. Index changes in place (same index name, another definition) are not generated yet: they raise IL4013 and nothing is written.
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

### Migrations on MySQL

With `mysql()` as the database, `inferlo db migrate` writes MySQL SQL and `--apply` runs it on MySQL. The snapshot records the database (`"dialect": "mysql"`), so a migrations folder written for PostgreSQL is refused with IL4037 instead of being run on MySQL, and the other way round.

- Generated so far: new tables (with their foreign keys), new columns (a foreign key for a new `t.ref`, and a fixed `.default()` for a new required column, IL4014), new indexes, and with `--allow-drop` drops of indexes (`DROP INDEX ... ON ...`), columns (a reference's foreign key is dropped first, since MySQL refuses to drop a column a foreign key uses) and tables (in one `DROP TABLE IF EXISTS`, which fails if a table that stays still references one of them). Without `--allow-drop`, drops raise IL4017. Column changes and renames are refused with IL4013 on MySQL for now: write those statements yourself in a new migration file.
- MySQL commits every schema change (`CREATE`, `ALTER`, `DROP`) as it runs, so a migration file cannot be rolled back as a whole. `--apply` runs a file statement by statement (split at the semicolons outside strings, quoted names and comments) and records it once every statement ran. If one fails, IL4038 names the file, the statement and MySQL's message; the statements before it stay applied and the file is not recorded, so remove the ones that ran, fix the rest and apply again.
- A named lock (`GET_LOCK`) lets one instance apply at a time, so running `--apply` on every deploy from several instances is safe. Applied files are recorded in the `inferlo_migrations` table with a SHA-256 checksum, and edited files are reported with IL4018, as on Postgres.

## Transactions and raw SQL

```ts
await db.$transaction(async (tx) => {
  const order = await tx.orders.insert({ ... });
  await tx.order_items.insertMany(items.map((i) => ({ ...i, orderId: order.id })));
});

await db.$sql("select count(*) from tickets where owner_id = $1", [user.id]);   // always use $1 placeholders
```

`db.$pgClient()` returns the `pg` client Inferlo's queries run on: the pool, or inside `$transaction` the transaction's connection. Libraries that take a pg client, such as Drizzle, can then work in the same transaction: `drizzle({ client: await tx.$pgClient<pg.PoolClient>() })` (see [Drizzle ORM](integrations.md#drizzle-orm)). Prisma shares the pool through its driver adapter, `new PrismaClient({ adapter: new PrismaPg(pool) })` (see [Prisma](integrations.md#prisma)). `postgres({ pool })` takes a `pg.Pool` you created, so another library can share it. Apps on postgres.js give Inferlo their `sql` instance instead: `postgres({ pool: postgresJsPool(sql) })` from `@browserlessapi/inferlo/postgres-js` (see [postgres.js](integrations.md#postgresjs)).
