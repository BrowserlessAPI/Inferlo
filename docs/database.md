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
- Relations go one way for now: from the row with the ref to the row it points to.

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
