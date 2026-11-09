# CLI

```
inferlo new <dir>              Create a project
inferlo dev                    Run src/server.ts and restart on changes
inferlo worker                 Run background jobs from the database queue until SIGTERM or Ctrl+C
inferlo describe [--json]      App map: models, routes, auth, AI
inferlo check [--json]         Typecheck, load the app, run tests
inferlo db push [--dry-run]    Create missing tables, columns and indexes
inferlo db migrate [name]      Write migrations/NNNN_name.sql for model changes (--dry-run to preview, --allow-drop to include drops, --allow-change to include type, default, required, enum value and reference changes, --rename old=new for each renamed table or column)
inferlo db migrate --apply     Run pending migration files
inferlo openapi [--out file]   Print or write the OpenAPI document
inferlo add resource <name>    Generate a model and CRUD routes
inferlo prompts [--check]      Write src/prompts/index.ts from src/prompts/*.md (--check: fail when it is out of date)
inferlo version
```

Every command accepts `--json` and exits non-zero on failure. With `--json`, errors are printed to stdout as:

```json
{ "ok": false, "error": { "code": "IL8007", "message": "...", "fix": "...", "docs": "https://..." }, "message": "..." }
```

The CLI always includes the real `message` and the `fix` (and `details` when there are any), also for errors with a 500 status that an HTTP response would hide.

The app entry is `src/app.ts` by default. Change it with `"inferlo": { "entry": "...", "server": "..." }` in package.json or `--entry <file>`.

## inferlo check --json

```json
{
  "ok": false,
  "steps": [
    { "name": "typecheck", "ok": false, "errors": [{ "file": "src/routes/notes.ts", "line": 14, "code": "TS2339", "message": "Property 'titel' does not exist..." }] },
    { "name": "load", "ok": true, "errors": [] },
    { "name": "test", "ok": true, "errors": [] }
  ]
}
```

Agents should run this after every change and not stop until `ok` is `true`.

## inferlo db migrate --json

```json
{ "ok": true, "dryRun": false, "file": "migrations/0002_add_due_dates.sql", "statements": ["ALTER TABLE \"tasks\" ADD COLUMN IF NOT EXISTS \"due_at\" timestamptz"], "drops": [] }
```

`file` is `null` when nothing changed or with `--dry-run`. `drops` lists the drops in the file (only with `--allow-drop`), e.g. `["drop column tasks.notes"]`, and `changes` lists the column changes (only with `--allow-change`), e.g. `["change column tasks.done (default false -> none)"]`, and `renames` the renames (only with `--rename`), e.g. `["rename column tasks.color -> tasks.colour"]`. `inferlo db migrate --apply --json` prints `{ "ok": true, "applied": ["0002_add_due_dates"], "edited": [] }`. `edited` lists migrations that were applied earlier but whose file has changed since (warning IL4018); they are not run again. See [Migrations](database.md#migrations).

## inferlo worker

Runs the app's background jobs in their own process, for deployments where web servers and job workers scale separately. It loads the app (reading `.env` first, like `inferlo dev`; variables already set win), calls `app.jobs.start()`, and on SIGTERM or Ctrl+C stops taking new jobs, waits for the running one to finish, closes the database and exits 0. A second signal exits at once.

It needs jobs (IL8007) and a shared queue, `createApp({ jobQueue: { store: "database" } })` or `{ store: "redis" }` (IL8008), because a separate process cannot see an in-memory queue. Run as many workers as you like: each job attempt runs on one of them. With `--json` it prints `{ "ok": true, "event": "started", "jobs": ["send-email"], "queue": "database" }` and a `"stopped"` event. See [Background jobs](jobs.md).

## inferlo add resource invoices

Adds an `Invoice` model to `src/models.ts`, creates `src/routes/invoices.ts` with list, get, create, update and delete routes that check ownership, and registers the routes in `src/app.ts`. It edits files only at the `// inferlo:models` and `// inferlo:routes` markers; without them it prints what to add.

## inferlo prompts

Reads every prompt file in `src/prompts/*.md` and writes `src/prompts/index.ts`, one typed `prompt()` export per file (`summarize-ticket.md` becomes `summarizeTicket`). Run it after changing a prompt file and commit both. `inferlo prompts --check` changes nothing and fails with IL8009 when `src/prompts/index.ts` is out of date, for CI. An invalid file fails with IL5039 and its line. See [Prompt files](ai.md#prompt-files).
