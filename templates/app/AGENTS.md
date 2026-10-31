# AGENTS.md

This is a [Kairo](https://github.com/BrowserlessAPI/kairo) backend. Kairo is a TypeScript backend framework designed so AI coding agents get things right the first time. Follow these rules.

## Before you change anything

```bash
npx kairo describe --json   # every model, field, route, auth rule and AI alias
```

Read that instead of searching the codebase. After every change run:

```bash
npx kairo check --json      # typecheck + load the app + tests, machine-readable errors
```

Do not finish until `kairo check` passes.

## Layout

| File | What goes there |
|---|---|
| `src/models.ts` | Every model (`model("table_name", { ... })`) and the `models` array |
| `src/routes/<feature>.ts` | Routes for one feature, each one an exported `const` |
| `src/app.ts` | `createApp({ models, routes, db, auth, ai })`. Import route modules with `import * as x` |
| `src/server.ts` | Starts the server. Keep it small |
| `test/<feature>.test.ts` | Tests using `app.request(path, { method, json, as: user })` |

## Rules

1. **One way to do each thing.** Routes: `route.get/post/put/patch/delete(path, options).handle(fn)`. Validation: `t.*` schemas. Database: `db.<table>.<method>`. AI: `ai.generate` / `ai.stream` / `ai.embed`.
2. **Routes are private by default.** A route without `auth` needs a signed-in user. Use `auth: "public"` only for routes anyone may call, and `auth: "<role>"` for role checks.
3. **Validate every input with a schema.** `body`, `query` and `params` options. Reuse model schemas: `Ticket.pick("title", "body")`, `Ticket.omit("ownerId")`, `.partial()` for PATCH.
4. **Check ownership.** Fetch with `db.x.get(id)` (throws 404) and compare `ownerId` to `user.id`; throw `notFound()` when it does not match, so other users' ids are not revealed.
5. **Never write raw SQL with string concatenation.** Use the table methods. If you really need SQL, use `db.$sql(text, params)` with `$1` placeholders.
6. **Model ids, timestamps:** every model already has `id`, `createdAt`, `updatedAt`. Never define them or send them as input.
7. **New field?** Add it to the model in `src/models.ts`, then run `npx kairo db push` in development, or `npx kairo db migrate <name>` to write a migration file for production (applied with `npx kairo db migrate --apply`). Use `.optional()` or `.default()` for new fields on existing tables. Never edit `migrations/snapshot.json`. Removing a model or field needs `npx kairo db migrate <name> --allow-drop` (it deletes that data); never use it for a rename.
8. **New resource?** `npx kairo add resource <plural_name>` generates the model and CRUD routes. Then edit them.
9. **AI calls** use aliases from `src/app.ts` (`model: "fast"`), never hard-coded provider model ids in routes. Use `output: schema` for structured data and `for: user.id` so usage is tracked per user.
10. **Errors:** throw `notFound()`, `forbidden()`, `badRequest()` or `httpError(status, message)`. Every Kairo error has a code (KRxxxx), a fix and a docs link: read the fix before changing code.
11. **Imports:** relative imports end in `.ts` (`import { Note } from "../models.ts"`).
12. **Expose to AI agents:** add `tool: true` to a route to make it an MCP tool at `/mcp`. Same auth applies.

## Testing

```ts
const res = await app.request("/notes", { method: "POST", json: { title: "Hi" }, as: user });
const note = await readJson(res, 201);   // from "@browserlessapi/kairo/testing"
```

Use `memory()` for the database and `mockProvider()` for AI in tests.

Full docs: https://github.com/BrowserlessAPI/kairo/tree/main/docs
