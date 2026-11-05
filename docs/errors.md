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


### IL2005
**Too many requests (429).** The route's `rateLimit` allows `max` requests per window for this user or IP. Wait the number of seconds in the `Retry-After` header before retrying.

### IL2006
**The server is shutting down (503).** `app.close()` was called (usually on SIGTERM during a deploy) and this instance no longer takes new requests. The response has `Connection: close`; retry the request and another instance answers it. See [graceful shutdown](deploy.md#graceful-shutdown).

### IL2007
**The request took too long (503).** The route did not finish (reading the body and running the handler) within its time limit: `createApp({ requestTimeoutMs })` (default 60000 ms) or the route's own `timeoutMs`. `ctx.signal` is aborted, model calls through `ctx.ai` are cancelled, and new `ctx.db` queries fail with this code. Make the handler faster, move slow work to a [background job](jobs.md), or raise the limit for that route: `route.post(path, { timeoutMs: 120_000 })`. See [request timeouts](security.md#request-timeouts).
## Auth (3xxx)

### IL3001
**Sign in required (401).** The route is private (the default) and `auth.resolve` returned no user.

### IL3002
**Forbidden (403).** The user lacks the role the route requires (`auth: "admin"`), or a handler threw `forbidden()`.

### IL3003
**Private routes but no auth configured.** Raised by `createApp` at startup. Either add `auth: "public"` to routes anyone may call, or pass `createApp({ auth })`.

### IL3004
**Permission denied (403).** The signed-in user does not have the permission a route requires (`permission: "reports.view"`), or a handler called `access.authorize(name, { user, ... })` and the rule returned `false`. Sign in as a user the rule allows, or change the rule in `permissions({ ... })`. See [Permissions](auth.md#permissions).

### IL3005
**Missing or invalid CSRF token (403).** The request has a valid `sessions()` cookie and changes data (POST, PUT, PATCH or DELETE), but it did not send the session's CSRF token, or sent another one. Send it in an `X-CSRF-Token` header (the value returned by `session.signIn(ctx, userId)`, also in the readable `inferlo_session_csrf` cookie) or, from an HTML form, in a hidden `_csrf` field (the value of `await session.csrfToken(req)`). This is what stops other sites from making a signed-in browser change data. See [Cookie sessions](auth.md#cookie-sessions).

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

### IL5009
**Route tools outside a route handler.** Routes passed to `ai.generate({ tools })` only work through `ctx.ai` in a route handler, so every tool call runs as the signed-in user with the route's auth and validation. Outside a route handler (with `createAI`), make function tools with `tool(name, { description, input }).handle(fn)` instead.

### IL5010
**Step limit reached (502).** The model was still calling tools after `maxSteps` model calls (default 5). Raise `maxSteps`, give the model fewer and more specific tools, or say in the prompt when to stop. `details` (server log) lists the tools called in each step.

### IL5011
**Tool is not a route of this app.** A route passed to `ai.generate({ tools })` is not registered in `createApp({ routes })`. Register it, or pass a route that is.

### IL5012
**Invalid image.** An image passed to `ai.generate` or `ai.stream` (with `images` next to `prompt`, or on a message) is not usable. Each image is `{ url }` with an `https://`, `http://` or `data:` URL, or `{ base64, mediaType }` with base64 data (no `data:` prefix, no line breaks) and a media type of `image/png`, `image/jpeg`, `image/gif` or `image/webp`. Only user messages can have images, and `images` needs a `prompt`. The call is rejected before any model is called.

### IL5013
**Invalid tool.** A `tool(name, { description, input }).handle(fn)` definition is not usable: the name must be letters, digits, `_` and `-`, starting with a letter, at most 64 characters (what providers accept); `description` must say what the tool does; `input` must be a `t.object({ ... })` schema; `handle` needs a function. Also raised when two tools in one `ai.generate` call have the same name.

### IL5014
**inferloAI() needs an AI client.** The Hono middleware from `@browserlessapi/inferlo/hono`, the Express middleware from `@browserlessapi/inferlo/express`, the Koa middleware from `@browserlessapi/inferlo/koa`, `inferloPlugin` from `@browserlessapi/inferlo/fastify`, the Elysia plugin from `@browserlessapi/inferlo/elysia`, `InferloModule` from `@browserlessapi/inferlo/nestjs`, the tRPC middleware from `@browserlessapi/inferlo/trpc`, the AdonisJS provider from `@browserlessapi/inferlo/adonisjs` (the default export of `config/ai.ts`), the Nitro plugin from `@browserlessapi/inferlo/h3` or `inferloAI()` from `@browserlessapi/inferlo/tsed` was given something that is not an AI client. Pass `createAI({ providers, models })` from `@browserlessapi/inferlo/ai`, or an Inferlo app's `app.ai`: `hono.use(inferloAI(ai))`, `server.use(inferloAI(ai))`, `koa.use(inferloAI(ai))`, `new Elysia().use(inferloAI(ai))`, `trpc.procedure.use(inferloAI(ai))` or `@Configuration({ imports: [inferloAI(ai)] })`.

### IL5015
**Invalid inferloPlugin options.** `fastify.register(inferloPlugin, options)` from `@browserlessapi/inferlo/fastify` needs `ai` (for `fastify.ai` and `request.ai`), `app` (an Inferlo app from `createApp`) with a `prefix` such as `"/api"` (starting with `/`, not ending with `/`), or both: `fastify.register(inferloPlugin, { app, prefix: "/api" })`. With `fallthrough: true` (which must be `true` or `false`), the prefix is optional: `fastify.register(inferloPlugin, { app, fallthrough: true })`.

### IL5016
**Invalid InferloModule options.** `InferloModule.forRoot()` from `@browserlessapi/inferlo/nestjs` needs `{ ai }`, and `InferloModule.forRootAsync()` needs a `useFactory` function that returns the AI client: `InferloModule.forRootAsync({ inject: [ConfigService], useFactory: (config) => createAI({ ... }) })`.

### IL5017
**Invalid trpcTools() options.** `trpcTools(router, { caller, procedures })` from `@browserlessapi/inferlo/trpc` needs a tRPC router, a `caller` (`appRouter.createCaller(ctx)`) and at least one procedure path with a description: `procedures: { "tickets.create": "Create a support ticket." }`. Each path must be a query or mutation of the router (not a subscription), and its input must be a `t.object({ ... })` schema; for procedures with another input (for example Zod), pass `{ description, input: t.object({ ... }) }`. The message lists every problem.

### IL5018
**No config/ai.ts for the AdonisJS provider.** The provider from `@browserlessapi/inferlo/adonisjs` (in `adonisrc.ts`) reads the AI client from `config/ai.ts` when the app boots, and that file is missing or has no default export. Create it with `export default createAI({ providers, models })` from `@browserlessapi/inferlo/ai`; see [Use with other frameworks](integrations.md#adonisjs).

### IL5019
**Invalid `toNodeHandler` or `toKoaMiddleware` options.** `fallthrough` is `true` or `false`, and `toNodeHandler(app, { fallthrough: true })` (also `toKoaMiddleware` and `inferloPlugin` from `@browserlessapi/inferlo/fastify` with `fallthrough: true`) needs an app returned by `createApp`, because it checks the app's routes to decide which requests to pass to the host framework's `next()`. A plain `{ fetch }` handler cannot be used with it. See [toNodeHandler](integrations.md#nodejs-frameworks-tonodehandler).

### IL5020
**Invalid `toNextHandlers` arguments.** `toNextHandlers(app, { prefix })` from `@browserlessapi/inferlo/nextjs` takes the app returned by `createApp` (anything with a `fetch` function) and an optional `prefix` that starts with `/`, such as `"/api"` for `app/api/[[...path]]/route.ts`. See [Next.js](integrations.md#nextjs).

### IL5021
**Invalid toH3Handler() arguments.** `toH3Handler(app, { prefix })` from `@browserlessapi/inferlo/h3` needs the app returned by `createApp` and, if given, a `prefix` that starts with `/`, such as `"/api"` for `server/routes/api/[...path].ts`: `export default toH3Handler(app, { prefix: "/api" })`. The handler it returns must be called by h3 (a Nitro or Nuxt server route, or an h3 app), with an h3 event. See [Nuxt, Nitro and h3](integrations.md#nuxt-nitro-and-h3).

### IL5022
**Invalid toSvelteKitHandlers() arguments.** `toSvelteKitHandlers(app, { prefix })` from `@browserlessapi/inferlo/sveltekit` needs the app returned by `createApp` and, if given, a `prefix` that starts with `/`, such as `"/api"` for `src/routes/api/[...path]/+server.ts`: `export const { GET, POST, fallback } = toSvelteKitHandlers(app, { prefix: "/api" })`. The handlers it returns must be exported from a `+server.ts` file, so SvelteKit calls them with a request event. See [SvelteKit](integrations.md#sveltekit).

### IL5023
**Invalid toReactRouterHandlers() arguments.** `toReactRouterHandlers(app, { prefix })` from `@browserlessapi/inferlo/react-router` needs the app returned by `createApp` and, if given, a `prefix` that starts with `/`, such as `"/api"` for `route("api/*", "routes/api.ts")`: `export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" })`. The loader and action it returns must be exported from a route module, so React Router calls them with `{ request }`. See [React Router](integrations.md#react-router-remix).

### IL5024
**Invalid toLambdaHandler() arguments or event.** `toLambdaHandler(app, { prefix, streaming })` from `@browserlessapi/inferlo/lambda` needs the app returned by `createApp`; `prefix`, if given, starts with `/` (such as `"/prod"`), and `streaming` is `true` or `false`. `streaming: true` only works inside the AWS Lambda Node.js runtime, which provides the `awslambda` global. The handler only takes HTTP events from a Lambda function URL or API Gateway (HTTP API or REST API with a Lambda proxy integration); other event sources such as SQS, S3 or schedules need their own handler. See [AWS Lambda](integrations.md#aws-lambda).

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


### IL6007
**Invalid rate limit configuration.** `rateLimit` needs `max` (a whole number of at least 1), `per` (`"second"`, `"minute"`, `"hour"` or `"day"`) and optionally `by` (`"user"` or `"ip"`); `createApp({ rateLimit: { store } })` takes `"memory"` or `"database"`.

### IL6008
**Rate limit store "database" needs Postgres.** Use `postgres()` for `createApp({ db })`, or the default `"memory"` store.

### IL6009
**Invalid job.** A job name must be lowercase letters, digits and dashes, starting with a letter (`"send-email"`), unique in the app, with `input` a schema and `retries` a whole number from 0 to 25. `enqueue(..., { runAt })` needs a valid `Date`.

### IL6010
**Job is not registered.** The job passed to `jobs.enqueue` (or a queued job's name) is not in `createApp({ jobs: [...] })`. Pass a value made with `job(...).handle(...)` and register it, or its module.

### IL6011
**Invalid job queue configuration.** `createApp({ jobQueue: { store } })` takes `"memory"` (the default) or `"database"`.

### IL6012
**Job queue store "database" needs Postgres.** Use `postgres()` for `createApp({ db })`, or the default `"memory"` store.

### IL6013
**Invalid cron.** `cron(schedule, job)` needs five fields, `minute hour day-of-month month day-of-week` in UTC (numbers, `*`, ranges `1-5`, lists `1,15`, steps `*/15`, and month and weekday names such as `jan` or `mon`), a schedule that matches some date, and a job whose input schema accepts `{}`.

### IL6014
**Invalid health options.** `createApp({ health })` takes `true` or `{ path, readyPath, checks, timeoutMs }`: paths start with `/`, differ from each other and from the OpenAPI and MCP paths, and no `GET` route uses them (remove your own `/health` route when you turn this on); `checks` are functions named anything but the built-in `database` and `ai`; `timeoutMs` is a positive number.

### IL6015
**Invalid `app.close()` options.** `delayMs` and `timeoutMs` are numbers of milliseconds, 0 or more: `app.close({ delayMs: 5000, timeoutMs: 10000 })`.

### IL6016
**Invalid `secureHeaders`.** `createApp({ secureHeaders })` takes `true` (the default), `false` (no security headers), or an object of header names to a string value or `false` (leave that header out): `{ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": false }`. Values cannot contain line breaks. See [security](security.md#security-headers).

### IL6017
**Invalid request timeout.** `createApp({ requestTimeoutMs })` and a route's `timeoutMs` take a positive number of milliseconds (`30_000`) or `false` for no limit. The message names the route.

### IL6018
**Invalid `redact`.** `createApp({ redact })` takes an array of strings (values to hide from logs) and `config()` results (their `secrets` are hidden): `redact: [settings, process.env.WEBHOOK_SECRET]`. `undefined` and empty strings are skipped. See [secrets in logs](security.md#secrets-in-logs).

### IL6019
**Invalid `logging`.** `createApp({ logging })` takes `{ format, requests }`: `format` is `"text"` (default) or `"json"`, and `requests` is `true` or `false`. `format` only applies to the built-in logger, so leave it out when you pass your own `logger` (it decides how entries are written, and gets fields such as `requestId` as the third argument). See [Observability](observability.md).

### IL6020
**Invalid `metrics`.** `createApp({ metrics })` takes `true` or `{ path, token, buckets }`: `path` starts with `/` and is not the OpenAPI, MCP or health path or a `GET` route; `token` is a string of at least 16 characters, not `undefined` (a random secret from configuration, sent by the scraper as `Authorization: Bearer <token>`); `buckets` are increasing positive numbers of seconds. See [metrics](observability.md#metrics).

### IL6021
**Invalid `deprecated` option.** A route's `deprecated` takes `true` or `{ since, sunset, link }`: `since` and `sunset` are dates (`"2026-11-01"`), ISO timestamps or valid `Date` values, `sunset` is after `since`, and `link` is an http or https URL. The message names the route. See [deprecating routes](routes.md#deprecating-routes).

### IL6022
**Invalid module.** `module(name, options)` takes a name of lowercase letters, digits and dashes starting with a letter (`"billing"`, `"user-profiles"`) and an object with `description` (a string), `imports` (modules created with `module()`, each once, not the module itself), `models` (models), `routes` and `jobs` (arrays, like in `createApp`) and `provides` (an object of functions and values). The message names the option; an unknown option gets a "Did you mean" hint. See [Modules](modules.md).

### IL6023
**Modules do not fit together.** `createApp({ modules })` takes an array of modules with unique names, each listed once. Every module a module `imports` must be in that array too (the same value, not another module with the same name), and a model belongs to one place: one module or `createApp({ models })`. The message names the modules; add the missing module to `createApp({ modules })` or move the model. See [Modules](modules.md#what-createapp-checks).

### IL6024
**A module's model references a module it does not import.** A `t.ref("users")` field in a model of the `billing` module points at a model owned by the `users` module, but `billing` does not list `users` in its `imports`. Add it: `module("billing", { imports: [users], ... })`. Models may reference models of their own module, of imported modules, and of `createApp({ models })`. See [Modules](modules.md#what-createapp-checks).

### IL6025
**Invalid API version.** `apiVersion(version, routes, options)` takes a version of `"v"` and a number (`"v1"`, `"v2"`), a non-empty array of routes or route files, and options with only `deprecated`. A route returned by `apiVersion()` cannot be put in another version: pass the original route to each version instead. `app.openapi({ version })` needs a version the app has, and no `GET` route may use a version's OpenAPI document path (`/v1/openapi.json`). See [API versions](routes.md#api-versions).

### IL6026
**Invalid permissions.** `permissions({ ... })` takes an object of named rules: each name like `"tickets.update"`, each rule a function that returns `true` or `false` or `{ roles: ["admin"] }` with at least one role. A function rule that returns anything other than `true` or `false` raises it when checked, as does `can()` or `authorize()` with an unknown name. `createApp` raises it when a route's `permission` is not defined, when a route has a `permission` but the app has no `createApp({ permissions })`, when a route combines `permission` with `auth: "public"`, or when `permissions` is not the result of `permissions()`. See [Permissions](auth.md#permissions).

### IL6027
**Audit log not available or used wrongly.** `ctx.audit(action, entry)` in a route or job needs the built-in `AuditLog` model in `createApp({ models: [...models, AuditLog] })` (run `inferlo db migrate` to create the `audit_log` table), an action name such as `"tickets.update"`, and an object as `entry`. See [Audit log](auth.md#audit-log).

### IL6028
**Invalid cache options or cache call.** `createApp({ cache })` takes `{ store: "memory" }` (the default, with an optional `maxEntries`, a whole number of at least 1) or `{ store: "database" }`, which needs `postgres()` as the database. Cache calls need a key of 1 to 512 characters, `{ ttlMs }` with a whole number of milliseconds from 1 to 365 days, tags that are strings of 1 to 256 characters, and a value that can be stored as JSON (not `undefined`, a function or a `BigInt`; cache `null` for "nothing"): `await cache.getOrSet("tickets:stats", { ttlMs: 60_000, tags: ["tickets"] }, compute)`. The route option `cache` only works on GET routes and takes `{ ttlMs, by: "user" | "public", tags }`: `route.get("/tickets/stats", { cache: { ttlMs: 60_000, tags: ["tickets"] } })`. See [Caching](caching.md).

### IL6029
**Invalid sessions() options or call.** `sessions({ secret, user })` needs a `secret` of at least 32 characters (or a list of them for rotation, newest first; generate one with `openssl rand -base64 32` and keep it in `config({ secrets })`) and a `user({ userId, issuedAt }, { db })` function that loads the signed-in user. `maxAgeMs` is a whole number of milliseconds from 1 minute to 400 days, `cookie.name` a valid cookie name, `cookie.sameSite` `"lax"` or `"strict"`, and `cookie.domain` and `cookie.path` strings without spaces, commas or semicolons. `session.signIn(ctx, userId)` and `session.signOut(ctx)` need the route's context and a non-empty user id. See [Cookie sessions](auth.md#cookie-sessions).

### IL6030
**Invalid tracing options.** `createApp({ tracing })` takes `{ api }` with the OpenTelemetry API (`import * as otel from "@opentelemetry/api"`, then `tracing: { api: otel }`) and an optional non-empty `tracerName`. Install `@opentelemetry/api` 1.3 or newer, and start an OpenTelemetry SDK so the spans are exported. See [Tracing](observability.md#tracing-opentelemetry).

## Environment (7xxx)

### IL7001
**Environment variable not set.** Set it, or pass a default: `env("NAME", { default: "..." })`.

### IL7002
**Environment variable has the wrong format** (for `env.int` or `env.bool`).

### IL7003
**Configuration is invalid.** `config({ schema })` found variables that are missing or do not match their field. The message and `details.issues` list each one (`key`, `code`, `message`); values of `secrets` are never shown. Set the variables in your environment or `.env` file, add values for this environment to `environments`, or give the fields a `.default(...)` or `.optional()`. `details.environment` says which environment was used (`INFERLO_ENV`, then `NODE_ENV`, then `"development"`).

### IL7004
**Invalid config options.** `config()` needs `schema: t.object({ ... })` with one non-object field per variable, `secrets` that are fields of the schema, and `environments` whose values are objects of schema fields: `environments: { test: { PORT: "3001" } }`.

### IL4013
**Migration change not supported yet.** `inferlo db migrate` generates new tables, columns and indexes, drops with `--allow-drop`, and type, default, required and enum value changes with `--allow-change` (IL4019). Your models change an existing column's reference, or an index. `details.changes` lists them, and `details.columns` says what changed in each column (for example `reference authors on delete cascade -> authors on delete restrict`). Undo the model change, or write the SQL yourself in a new migration file.

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
**Migration changes columns.** Your models change the type or default of an existing column, make it required or optional, or change an enum's values. `details.changes` lists them, for example `change column notes.body (optional -> required, default none -> '')`, and `details.columns` lists `{ table, column, changes }`. If you mean it, run `inferlo db migrate --allow-change` (or pass `{ allowChange: true }` to `planMigration`) and review the file. Otherwise undo the model change.

### IL4020
**Migration makes a column required, but rows have NULL in it.** `inferlo db migrate --apply` ran `SET NOT NULL` (or another statement that needs a value) and the column still has NULL rows. The migration was rolled back and not recorded. `details` has `migration`, `table` and `column`. If the file has not been applied anywhere, add `UPDATE "table" SET "column" = <value> WHERE "column" IS NULL;` before the `SET NOT NULL`, or give the field a fixed `.default(value)` and generate the migration again. Or keep the field optional.

### IL4021
**Migration adds a check constraint, but rows do not satisfy it.** `inferlo db migrate --apply` replaced an enum's CHECK constraint (or ran another statement checked by one) and rows still have a value it does not allow, usually an enum value that was removed from the model. The migration was rolled back and not recorded. `details` has `migration`, `table` and `constraint`. If the file has not been applied anywhere, add `UPDATE "table" SET "column" = '<new value>' WHERE "column" = '<removed value>';` before the `ADD CONSTRAINT` statement. Or keep the removed value in the enum.

### IL4022
**Migration changes a column type, but a value does not convert.** `inferlo db migrate --apply` ran `ALTER COLUMN ... TYPE` and an existing value does not fit the new type: text that is not a number, a number with decimals going to `integer`, text longer than the new `varchar(n)`, or a value that is not a date. Values are never cut, rounded or set to NULL. The migration was rolled back and not recorded. `details` has `migration`, `columns` (the columns whose type the migration changes, as `table.column`) and `reason` (the Postgres message, which names the value). If the file has not been applied anywhere, add an `UPDATE` before the `ALTER COLUMN ... TYPE` statement that fixes or clears those values, or write your own `USING` expression. Or keep the old field type.

### IL4023
**Unknown relation in include.** The model has no relation with that name. Relations come from `t.ref` fields named `<name>Id` (`ownerId` gives `owner`), and from other models with such a field pointing to this one (included by their table name, `tickets`, or `<table>By<Name>` such as `ticketsByOwner` when that table has several). A table name with several ref fields to this model is ambiguous; the fix names the `<table>By<Name>` relations to use. The fix lists the model's relations. Values must be `true` or `false`.

### IL4024
**Invalid pagination cursor (400).** The `cursor` passed to `paginate()` is not a `nextCursor` from it, was changed, or was made for a different `orderBy`. Pass `nextCursor` back unchanged with the same `orderBy`, or leave `cursor` out for the first page. The status is 400, so a bad `?cursor=` from a client gets a clear error.

### IL4025
**Invalid paginate options.** `paginate()` orders by one field, which must be required (not optional without a default, not nullable) and not `json`, `array` or `object`, and it does not take `offset`. Use for example `orderBy: { createdAt: "desc" }`; use `findMany({ offset })` for numbered pages.

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

### IL8007
**No background jobs to run.** `inferlo worker` found no jobs in the app. Define them with `job(...).handle(...)` and register them with `createApp({ jobs: [jobs] })`.

### IL8008
**`inferlo worker` needs the database job queue.** With the default in-memory queue a separate process cannot see the jobs the server enqueues. Set `createApp({ jobQueue: { store: "database" } })` with the Postgres adapter, or run jobs in the server process with `app.jobs.start()`.

## Internal (9xxx)

### IL9000
**Unexpected error (500).** Something threw that was not an Inferlo error. The full error is logged on the server; set `createApp({ exposeErrors: true })` in development to include the message in responses.
