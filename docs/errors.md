# Error codes

Every Kairo error has a stable code. A code never changes meaning once released. API responses look like this:

```json
{
  "error": {
    "code": "KR1001",
    "message": "Invalid request body. title: Required.",
    "fix": "Send data that matches the schema. Each entry in details names the exact path and problem.",
    "details": [{ "path": ["title"], "code": "required", "message": "Required." }],
    "docs": "https://github.com/BrowserlessAPI/kairo/blob/main/docs/errors.md#kr1001"
  }
}
```

Errors with status 500 or higher hide their message from API clients ("Internal server error") and log the full error on the server.

## Validation (1xxx)

### KR1001
**Invalid input (422).** A body, query string, path parameter, insert or update did not match its schema. `details` lists each problem with its `path` and an issue `code`: `required`, `invalid_type`, `too_short`, `too_long`, `too_small`, `too_big`, `invalid_enum`, `invalid_email`, `invalid_url`, `invalid_uuid`, `invalid_date`, `invalid_format`, `unknown_key`, `read_only`. `unknown_key` and `invalid_enum` include a "Did you mean" hint.

### KR1003
**pick() named a field that does not exist.** Check the spelling against the model.

## Routing (2xxx)

### KR2001
**No route matches (404).** The message names the closest route path.

### KR2002
**Method not allowed (405).** The path exists with other methods, listed in the `Allow` header.

### KR2003
**Request body is not valid JSON (400).** Send JSON with `Content-Type: application/json`.

### KR2004
**Request body too large (413).** Raise `createApp({ maxBodySize })` if needed.

## Auth (3xxx)

### KR3001
**Sign in required (401).** The route is private (the default) and `auth.resolve` returned no user.

### KR3002
**Forbidden (403).** The user lacks the role the route requires (`auth: "admin"`), or a handler threw `forbidden()`.

### KR3003
**Private routes but no auth configured.** Raised by `createApp` at startup. Either add `auth: "public"` to routes anyone may call, or pass `createApp({ auth })`.

## Database (4xxx)

### KR4001
**Record not found (404).** Raised by `db.<table>.get(id)`, `update(id)` and `notFound()`.

### KR4002
**Unknown table.** `db.<name>` is not a registered model. Add the model to `createApp({ models })`.

### KR4003
**Unknown field or operator in a query.** The message suggests the closest field. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `ilike`, `isNull`.

### KR4004
**Unique value already exists (409).** A field marked `.unique()` already has this value.

### KR4005
**Invalid table or field name.** Tables: lowercase letters, digits and underscores. Fields: camelCase.

### KR4006
**Model defines id, createdAt or updatedAt.** Kairo adds these automatically. Remove them.

### KR4007
**deleteMany() without a filter.** Pass a `where` filter to avoid deleting every row by accident.

### KR4008
**Raw SQL not supported by this adapter.** Use `postgres()`.

### KR4009
**postgres() has no connection URL.** Pass `postgres({ url: env("DATABASE_URL") })`.

### KR4010
**The pg package is not installed.** Run `npm install pg`.

### KR4011
**Foreign key violation (409).** The referenced row does not exist, or the row is still referenced elsewhere.

### KR4012
**Table missing.** Run `kairo db push`.

## AI (5xxx)

### KR5001
**AI not configured, or unknown model alias or provider.** Configure `createApp({ ai: { providers, models } })`. The message suggests the closest alias.

### KR5002
**Structured output did not match the schema (502).** Kairo asked the model to repair its answer and it still failed. Simplify the schema, add `.describe()` hints, or use a stronger model.

### KR5003
**Every model in the fallback list failed (502).** `details` (server log) lists each failure.

### KR5004
**AI usage blocked (402).** `ai.allow` returned false for this `for` id, for example because credits ran out.

### KR5005
**Provider does not support this operation** (streaming or embeddings).

### KR5006
**Provider HTTP error.** 401/403 means a bad API key. Timeouts, 429 and 5xx are retried on the next fallback model.

### KR5007
**No prompt.** Pass `prompt` or `messages`.

### KR5008
**A stream was read twice.** Call `ai.stream()` again.

## App configuration (6xxx)

### KR6001
**Duplicate route.** The same method and path (ignoring parameter names) is defined twice.

### KR6003
**Route path must start with "/".**

### KR6004
**Two models share a name.**

### KR6005
**t.ref() points to a model that is not registered.**

### KR6006
**Two route exports share a name.** Names are used for MCP tools and `describe`.

## Environment (7xxx)

### KR7001
**Environment variable not set.** Set it, or pass a default: `env("NAME", { default: "..." })`.

### KR7002
**Environment variable has the wrong format** (for `env.int` or `env.bool`).

### KR4013
**Migration change not supported yet.** `kairo db migrate` generates new tables, columns and indexes, and drops with `--allow-drop`. Your models change an existing column (type, required, default, enum values, reference) or index. `details.changes` lists them, and `details.columns` says what changed in each column (for example `type varchar(120) -> varchar(200)`). Undo the model change, or write the SQL yourself in a new migration file.

### KR4014
**New required column needs a value.** A required field was added to a table that already exists, so existing rows would have no value. Add a fixed `.default(value)` or `.optional()` to the field.

### KR4015
**Invalid migration snapshot.** `migrations/snapshot.json` is not the file written by `kairo db migrate`. Restore it from version control; do not edit it by hand.

### KR4016
**Invalid or duplicate migration name.** Migration names use letters, digits, `_` and `-` and must be unique, e.g. `0002_add_due_dates`.

### KR4017
**Migration drops data.** Your models no longer have a table, column or index that the last migration created. `details.drops` lists them. If you mean to delete that data, run `kairo db migrate --allow-drop` (or pass `{ allowDrop: true }` to `planMigration`) and review the file. Otherwise restore the removed model, field or index. A rename is not a drop: undo it and write the rename SQL yourself.

### KR4018
**Applied migration file was edited** (warning, not an error). `kairo db migrate --apply` records a checksum of each file it applies. This file was applied earlier and its SQL has changed since, so the change was not run (and never will be). `--apply` still runs the pending files and exits 0; `--json` lists the names in `edited`, and `applyMigrations` passes them to `onEdited`. Restore the applied SQL (for example `git checkout migrations/0001_init.sql`) and put the change in a new migration with `kairo db migrate <name>`.

## CLI (8xxx)

### KR8000
**Unknown command.** Run `kairo help`.

### KR8001
**App entry or server file not found.** Default entry is `src/app.ts`; set `"kairo": { "entry": "..." }` in package.json or pass `--entry`.

### KR8002
**Entry file does not export an app.** Add `export const app = createApp({ ... })`.

### KR8003
**Unknown db command.** Use `kairo db push` or `kairo db migrate`.

### KR8004
**Missing project directory** for `kairo new`.

### KR8005
**Target already exists.**

### KR8006
**Unknown generator.** Use `kairo add resource <plural_name>`.

## Internal (9xxx)

### KR9000
**Unexpected error (500).** Something threw that was not a Kairo error. The full error is logged on the server; set `createApp({ exposeErrors: true })` in development to include the message in responses.
