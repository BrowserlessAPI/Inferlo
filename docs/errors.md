# Error codes

Every Inferlo error has a stable code. A code never changes meaning once released. API responses look like this:

```json
{
  "error": {
    "code": "IL1001",
    "message": "Invalid request body. title: Required.",
    "fix": "Send data that matches the schema. Each entry in details names the exact path and problem.",
    "details": [{ "path": ["title"], "code": "required", "message": "Required." }],
    "docs": "https://github.com/BrowserlessAPI/Inferlo/blob/main/docs/errors.md#il1001"
  }
}
```

Errors with status 500 or higher hide their message from API clients ("Internal server error") and log the full error on the server.

## Validation (1xxx)

### IL1001
**Invalid input (422).** A body, query string, path parameter, insert or update did not match its schema. `details` lists each problem with its `path` and an issue `code`: `required`, `invalid_type`, `too_short`, `too_long`, `too_small`, `too_big`, `invalid_enum`, `invalid_email`, `invalid_url`, `invalid_uuid`, `invalid_date`, `invalid_format`, `unknown_key`, `read_only`. `unknown_key` and `invalid_enum` include a "Did you mean" hint.

### IL1003
**pick() named a field that does not exist.** Check the spelling against the model.

## Routing (2xxx)

### IL2001
**No route matches (404).** The message names the closest route path.

### IL2002
**Method not allowed (405).** The path exists with other methods, listed in the `Allow` header.

### IL2003
**Request body is not valid JSON (400).** Send JSON with `Content-Type: application/json`.

### IL2004
**Request body too large (413).** Raise `createApp({ maxBodySize })` if needed.

## Auth (3xxx)

### IL3001
**Sign in required (401).** The route is private (the default) and `auth.resolve` returned no user.

### IL3002
**Forbidden (403).** The user lacks the role the route requires (`auth: "admin"`), or a handler threw `forbidden()`.

### IL3003
**Private routes but no auth configured.** Raised by `createApp` at startup. Either add `auth: "public"` to routes anyone may call, or pass `createApp({ auth })`.

## Database (4xxx)

### IL4001
**Record not found (404).** Raised by `db.<table>.get(id)`, `update(id)` and `notFound()`.

### IL4002
**Unknown table.** `db.<name>` is not a registered model. Add the model to `createApp({ models })`.

### IL4003
**Unknown field or operator in a query.** The message suggests the closest field. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `ilike`, `isNull`.

### IL4004
**Unique value already exists (409).** A field marked `.unique()` already has this value.

### IL4005
**Invalid table or field name.** Tables: lowercase letters, digits and underscores. Fields: camelCase.

### IL4006
**Model defines id, createdAt or updatedAt.** Inferlo adds these automatically. Remove them.

### IL4007
**deleteMany() without a filter.** Pass a `where` filter to avoid deleting every row by accident.

### IL4008
**Raw SQL not supported by this adapter.** Use `postgres()`.

### IL4009
**postgres() has no connection URL.** Pass `postgres({ url: env("DATABASE_URL") })`.

### IL4010
**The pg package is not installed.** Run `npm install pg`.

### IL4011
**Foreign key violation (409).** The referenced row does not exist, or the row is still referenced elsewhere.

### IL4012
**Table missing.** Run `inferlo db push`.

## AI (5xxx)

### IL5001
**AI not configured, or unknown model alias or provider.** Configure `createApp({ ai: { providers, models } })`. The message suggests the closest alias.

### IL5002
**Structured output did not match the schema (502).** Inferlo asked the model to repair its answer and it still failed. Simplify the schema, add `.describe()` hints, or use a stronger model.

### IL5003
**Every model in the fallback list failed (502).** `details` (server log) lists each failure.

### IL5004
**AI usage blocked (402).** `ai.allow` returned false for this `for` id, for example because credits ran out.

### IL5005
**Provider does not support this operation** (streaming or embeddings).

### IL5006
**Provider HTTP error.** 401/403 means a bad API key. Timeouts, 429 and 5xx are retried on the next fallback model.

### IL5007
**No prompt.** Pass `prompt` or `messages`.

### IL5008
**A stream was read twice.** Call `ai.stream()` again.

## App configuration (6xxx)

### IL6001
**Duplicate route.** The same method and path (ignoring parameter names) is defined twice.

### IL6003
**Route path must start with "/".**

### IL6004
**Two models share a name.**

### IL6005
**t.ref() points to a model that is not registered.**

### IL6006
**Two route exports share a name.** Names are used for MCP tools and `describe`.

## Environment (7xxx)

### IL7001
**Environment variable not set.** Set it, or pass a default: `env("NAME", { default: "..." })`.

### IL7002
**Environment variable has the wrong format** (for `env.int` or `env.bool`).

### IL4013
**Migration change not supported yet.** `inferlo db migrate` generates new tables, columns and indexes, drops with `--allow-drop`, and default, required and enum value changes with `--allow-change` (IL4019). Your models change an existing column's type or reference, or an index. `details.changes` lists them, and `details.columns` says what changed in each column (for example `type varchar(120) -> varchar(200)`). Undo the model change, or write the SQL yourself in a new migration file.

### IL4014
**New required column needs a value.** A required field was added to a table that already exists, so existing rows would have no value. Add a fixed `.default(value)` or `.optional()` to the field.

### IL4015
**Invalid migration snapshot.** `migrations/snapshot.json` is not the file written by `inferlo db migrate`. Restore it from version control; do not edit it by hand.

### IL4016
**Invalid or duplicate migration name.** Migration names use letters, digits, `_` and `-` and must be unique, e.g. `0002_add_due_dates`.

### IL4017
**Migration drops data.** Your models no longer have a table, column or index that the last migration created. `details.drops` lists them. If you mean to delete that data, run `inferlo db migrate --allow-drop` (or pass `{ allowDrop: true }` to `planMigration`) and review the file. Otherwise restore the removed model, field or index. A rename is not a drop: undo it and write the rename SQL yourself.

### IL4018
**Applied migration file was edited** (warning, not an error). `inferlo db migrate --apply` records a checksum of each file it applies. This file was applied earlier and its SQL has changed since, so the change was not run (and never will be). `--apply` still runs the pending files and exits 0; `--json` lists the names in `edited`, and `applyMigrations` passes them to `onEdited`. Restore the applied SQL (for example `git checkout migrations/0001_init.sql`) and put the change in a new migration with `inferlo db migrate <name>`.

### IL4019
**Migration changes columns.** Your models change the default of an existing column, make it required or optional, or change an enum's values. `details.changes` lists them, for example `change column notes.body (optional -> required, default none -> '')`, and `details.columns` lists `{ table, column, changes }`. If you mean it, run `inferlo db migrate --allow-change` (or pass `{ allowChange: true }` to `planMigration`) and review the file. Otherwise undo the model change.

### IL4020
**Migration makes a column required, but rows have NULL in it.** `inferlo db migrate --apply` ran `SET NOT NULL` (or another statement that needs a value) and the column still has NULL rows. The migration was rolled back and not recorded. `details` has `migration`, `table` and `column`. If the file has not been applied anywhere, add `UPDATE "table" SET "column" = <value> WHERE "column" IS NULL;` before the `SET NOT NULL`, or give the field a fixed `.default(value)` and generate the migration again. Or keep the field optional.

### IL4021
**Migration adds a check constraint, but rows do not satisfy it.** `inferlo db migrate --apply` replaced an enum's CHECK constraint (or ran another statement checked by one) and rows still have a value it does not allow, usually an enum value that was removed from the model. The migration was rolled back and not recorded. `details` has `migration`, `table` and `constraint`. If the file has not been applied anywhere, add `UPDATE "table" SET "column" = '<new value>' WHERE "column" = '<removed value>';` before the `ADD CONSTRAINT` statement. Or keep the removed value in the enum.

## CLI (8xxx)

### IL8000
**Unknown command.** Run `inferlo help`.

### IL8001
**App entry or server file not found.** Default entry is `src/app.ts`; set `"inferlo": { "entry": "..." }` in package.json or pass `--entry`.

### IL8002
**Entry file does not export an app.** Add `export const app = createApp({ ... })`.

### IL8003
**Unknown db command.** Use `inferlo db push` or `inferlo db migrate`.

### IL8004
**Missing project directory** for `inferlo new`.

### IL8005
**Target already exists.**

### IL8006
**Unknown generator.** Use `inferlo add resource <plural_name>`.

## Internal (9xxx)

### IL9000
**Unexpected error (500).** Something threw that was not an Inferlo error. The full error is logged on the server; set `createApp({ exposeErrors: true })` in development to include the message in responses.
