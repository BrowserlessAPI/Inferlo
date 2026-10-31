# Models and database

## Models

```ts
import { model, t, type Row } from "@browserlessapi/kairo";

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

declare module "@browserlessapi/kairo" {
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
await db.tickets.get(id);                                               // row, or throws KR4001 (404)
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

Unknown fields or operators raise KR4003 with a "Did you mean" hint.

## Adapters

```ts
import { memory } from "@browserlessapi/kairo";
import { postgres } from "@browserlessapi/kairo/postgres";

createApp({ db: memory() });                                  // tests and prototypes
createApp({ db: postgres({ url: env("DATABASE_URL") }) });    // production (npm install pg)
```

## Schema changes

```bash
kairo db push --dry-run   # show the SQL
kairo db push             # create missing tables, columns and indexes
```

`db push` only adds things; it never drops or renames columns. New columns on existing tables should be `.optional()` or have a `.default()`. Use it for development and prototypes; use migrations in production.

## Migrations

```bash
kairo db migrate add_due_dates   # write migrations/0002_add_due_dates.sql for your model changes
kairo db migrate --dry-run       # print the SQL without writing anything
kairo db migrate drop_color --allow-drop   # include drops of tables, columns and indexes (deletes data)
kairo db migrate --apply         # run pending migration files against DATABASE_URL
```

- `kairo db migrate [name]` compares your models with `migrations/snapshot.json` (your models as of the last generated migration), writes the SQL for the difference to the next numbered file and updates the snapshot. With no changes it writes nothing. Commit both files.
- Review the generated SQL before applying it. You may edit a file until it has been applied anywhere; after that, add a new migration instead.
- `--apply` runs every file not yet recorded in the `kairo_migrations` table, in file name order, each in its own transaction, and records it with a SHA-256 checksum of its SQL. It is safe to run on every deploy and from several instances at once. Do not put `BEGIN` or `COMMIT` in migration files.
- If a file that was already applied has been edited since, `--apply` does not run it again: it prints warning KR4018 naming the file (and lists it in `edited` with `--json`), and still applies the pending files. Restore the applied SQL (for example with `git checkout`) and put the change in a new migration. Line ending changes (CRLF and LF) do not count as edits. Migrations applied with Kairo 0.2 get their checksum recorded from the current file on the next `--apply`.
- Generated statements use `IF NOT EXISTS`, so the first migration also works on a database created with `db push`.
- New tables, columns and indexes are generated directly. A new required column on an existing table raises KR4014: give it a fixed `.default(value)` or make it `.optional()`.
- Removing a model, field, `.unique()` or `.index()` drops data, so it raises KR4017 and nothing is written, unless you pass `--allow-drop`. Then the file gets `DROP INDEX`, `ALTER TABLE ... DROP COLUMN` and `DROP TABLE` statements (without `CASCADE`) and a warning comment, and `--json` output lists them in `drops`. Back up before applying it.
- Renames and changed columns (type, required, default, enum values, reference) are not generated yet: they raise KR4013 and nothing is written. A rename looks like a drop plus an add; do not use `--allow-drop` for a rename, or the column's data is lost.

To apply migrations from code, for example at startup in a serverless function:

```ts
import { applyMigrations } from "@browserlessapi/kairo";

await applyMigrations(app.db, [{ name: "0001_init", sql: initSql }]);   // returns the names it applied

// Applied migrations whose SQL changed since are not run again; onEdited gets their names (KR4018).
await applyMigrations(app.db, migrations, { onEdited: (names) => console.warn("Edited after apply:", names) });
```

To generate SQL from code, use `planMigration(models, snapshot, { allowDrop })`. It returns `{ statements, snapshot, drops }`:

```ts
import { planMigration } from "@browserlessapi/kairo";

const plan = planMigration(models, previousSnapshot, { allowDrop: true });   // allowDrop defaults to false
```

## Transactions and raw SQL (Postgres)

```ts
await db.$transaction(async (tx) => {
  const order = await tx.orders.insert({ ... });
  await tx.order_items.insertMany(items.map((i) => ({ ...i, orderId: order.id })));
});

await db.$sql("select count(*) from tickets where owner_id = $1", [user.id]);   // always use $1 placeholders
```
