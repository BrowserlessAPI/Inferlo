# CLI

```
kairo new <dir>              Create a project
kairo dev                    Run src/server.ts and restart on changes
kairo describe [--json]      App map: models, routes, auth, AI
kairo check [--json]         Typecheck, load the app, run tests
kairo db push [--dry-run]    Create missing tables, columns and indexes
kairo db migrate [name]      Write migrations/NNNN_name.sql for model changes (--dry-run to preview, --allow-drop to include drops)
kairo db migrate --apply     Run pending migration files
kairo openapi [--out file]   Print or write the OpenAPI document
kairo add resource <name>    Generate a model and CRUD routes
kairo version
```

Every command accepts `--json` and exits non-zero on failure.

The app entry is `src/app.ts` by default. Change it with `"kairo": { "entry": "...", "server": "..." }` in package.json or `--entry <file>`.

## kairo check --json

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

## kairo db migrate --json

```json
{ "ok": true, "dryRun": false, "file": "migrations/0002_add_due_dates.sql", "statements": ["ALTER TABLE \"tasks\" ADD COLUMN IF NOT EXISTS \"due_at\" timestamptz"], "drops": [] }
```

`file` is `null` when nothing changed or with `--dry-run`. `drops` lists the drops in the file (only with `--allow-drop`), e.g. `["drop column tasks.notes"]`. `kairo db migrate --apply --json` prints `{ "ok": true, "applied": ["0002_add_due_dates"], "edited": [] }`. `edited` lists migrations that were applied earlier but whose file has changed since (warning KR4018); they are not run again. See [Migrations](database.md#migrations).

## kairo add resource invoices

Adds an `Invoice` model to `src/models.ts`, creates `src/routes/invoices.ts` with list, get, create, update and delete routes that check ownership, and registers the routes in `src/app.ts`. It edits files only at the `// kairo:models` and `// kairo:routes` markers; without them it prints what to add.
