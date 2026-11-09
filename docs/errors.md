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
**Invalid input (422).** A body, query string, path parameter, insert or update did not match its schema. `details` lists each problem with its `path` and an issue `code`: `required`, `invalid_type`, `too_short`, `too_long`, `too_small`, `too_big`, `invalid_enum`, `invalid_email`, `invalid_url`, `invalid_uuid`, `invalid_date`, `invalid_format`, `unknown_key`, `read_only`, `invalid_dimensions` (a `t.vector()` value with the wrong number of numbers), and for uploaded files `file_too_large`, `file_too_small`, `file_type` and `file_content` (the file's bytes do not match its declared type). `unknown_key` and `invalid_enum` include a "Did you mean" hint.

### IL1003
**pick() named a field that does not exist.** Check the spelling against the model.

### IL1004
**Invalid file field.** `t.file({ maxBytes, types })` takes a whole number of bytes above 0 and a list of media types such as `"image/png"` or `"image/*"`. Files can only be top-level fields of a route body (`body: t.object({ avatar: t.file() })`), a list of files needs a limit (`t.array(t.file()).max(10)`), and a route with files cannot be an MCP or AI tool, because tools send JSON. Models cannot store files: store the file elsewhere and keep its key or URL in a `t.string()` field. See [File uploads](routes.md#file-uploads).

### IL1005
**Invalid t.vector() size.** `t.vector(dimensions)` takes a whole number from 1 to 16000 (pgvector's limit): the length of the vectors your embedding model returns, such as `t.vector(1536)` for OpenAI's text-embedding-3-small. See [Vector search](database.md#vector-search).

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

### IL2008
**A call to another service failed.** `client.call(route, ...)` from `serviceClient` got an error status from the other service, no answer within `timeoutMs`, or a network error. `remoteStatus` has the other service's status (0 when no answer came) and `remoteCode` its error code; unhandled, your service answers 502 and logs the details. Catch it for statuses you expect (`if (error instanceof ServiceCallError && error.remoteStatus === 404) throw notFound()`), check `baseUrl` and `token`, and see the other service's logs for the request id. See [Service-to-service calls](services.md).

### IL2009
**Invalid serviceClient() options or call.** `serviceClient({ baseUrl, token, headers, timeoutMs, retries, fetch })` needs an http or https `baseUrl` without a query string, a positive `timeoutMs` and a whole number of `retries` from 0 to 10. `client.call(route, input)` needs a route made with `route.<method>(...).handle(...)` and a value for every `:param` in its path. See [Service-to-service calls](services.md).

### IL2010
**Not a WebSocket upgrade (426), or an invalid handshake (400).** The path is a WebSocket route (`route.ws`), which only answers WebSocket upgrade requests (`GET` with `Upgrade: websocket`, `Sec-WebSocket-Version: 13` and a `Sec-WebSocket-Key`). Open it with a WebSocket client, `new WebSocket("wss://host/path")`, not with `fetch`. See [WebSockets](websockets.md).

### IL2011
**This server cannot accept WebSocket connections (501).** The upgrade request reached the app through a host that only passes Requests to `app.fetch` and cannot hand over the connection: `app.request()`, a serverless platform, or a `Bun.serve` without `websocket: bunWebSocket`. Serve the app with `app.listen()` or `serve(app)` on Node.js and Bun, or with `Deno.serve(app.fetch)` or `deno serve` on Deno; on a Node.js server another framework created, add `server.on("upgrade", toNodeUpgradeHandler(app))`; with your own `Bun.serve`, pass `websocket: bunWebSocket`. In tests, connect to `await app.listen(0)`. See [WebSockets](websockets.md#servers).

### IL2012
**Invalid WebSocket close code.** `ctx.socket.close(code, reason)` takes 1000 (normal closure, the default) or an application code from 3000 to 4999. The other codes are reserved by the WebSocket protocol for the server itself (1001 when the app shuts down, 1003, 1009).

### IL2013
**socket.stream() needs an AI stream.** `ctx.socket.stream(result)` sends a model's answer chunk by chunk, so it takes the result of `ai.stream(...)`: `await socket.stream(ai.stream({ model: "fast", prompt }))`. To send other data, use `socket.send(data)`. See [Streaming AI answers](websockets.md#streaming-ai-answers).

### IL2014
**Invalid room or broadcast.** A room name in `socket.join(room)`, `socket.leave(room)` or `sockets.broadcast(room, data)` must be a string of 1 to 200 characters, and `broadcast` needs data that can be sent as JSON (not `undefined`). Name rooms after what they are about, with its id: `` socket.join(`project:${params.id}`) ``. See [Rooms and broadcast](websockets.md#rooms-and-broadcast).

### IL2015
**Request body is not valid multipart/form-data (400).** The route takes files, the request said `Content-Type: multipart/form-data`, but the body could not be read as a form (a missing or wrong boundary, or a cut-off body). Send a `FormData` body without setting `Content-Type` yourself (fetch adds the boundary), or an HTML form with `enctype="multipart/form-data"`. See [File uploads](routes.md#file-uploads).

### IL2016
**The response does not match the route's response schema.** Outside production (see `createApp({ validateResponses })`), Inferlo checks each JSON answer of a route with a `response` schema against it, as clients receive it (JSON, dates as ISO strings). A field is missing, has the wrong type, or is not in the schema (object schemas reject unknown fields, which finds fields that should not be sent, such as a password hash). With `"warn"` (the default) the answer is sent and this is logged once per route; with `"error"` the request answers 500 with the field paths in `details`. Return exactly what the schema describes, for example `{ id: row.id, email: row.email, name: row.name }` instead of the whole row, or change the schema. See [Response validation](routes.md#response-validation).

### IL2017
**Idempotency-Key missing or invalid (400).** The route takes idempotency keys with `required: true` and the request had no `Idempotency-Key` header, or the key is not 1 to 255 visible ASCII characters. Send a new random key (a UUID) with each request, and the same key when you retry it. See [Idempotency keys](routes.md#idempotency-keys).

### IL2018
**A request with this Idempotency-Key is still running (409).** Another request with the same key, route and user has not finished yet; retry a moment later with the same key. Also answered for repeats of a request whose answer was not stored (it set a cookie, was an event stream or was larger than 1 MB). See [Idempotency keys](routes.md#idempotency-keys).

### IL2019
**Idempotency-Key reused for a different request (422).** The key was used before on this route by the same user, with another body, query or path. Send a new key for each new request; reuse a key only to retry exactly the same request. See [Idempotency keys](routes.md#idempotency-keys).

### IL2020
**Too many top-level GraphQL fields.** The GraphQL operation asks for more top-level fields (aliases and fragments included) than the endpoint's `maxFields` (default 20). Each top-level field runs a route, so split the work over several requests, or raise `graphqlRoute({ maxFields })`. Answered as a GraphQL error. See [GraphQL](graphql.md#limits).

### IL2021
**Too many GraphQL relation fields.** The GraphQL document asks for more [relation fields](graphql.md#relations) (aliases and fragments included) than the endpoint's `maxFields` (default 20). Each relation field runs its route once per list, so ask for fewer relations in one request, or raise `graphqlRoute({ maxFields })`. Answered as a GraphQL error. See [Relations](graphql.md#relations).

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

### IL3006
**WebSocket origin not allowed (403).** A browser page from another origin tried to open a WebSocket route. Browsers send cookies with WebSocket upgrades from any page, so only the app's own origin (the `Origin` host equals the `Host` header) and the origins in `createApp({ cors: { origin: [...] } })` may connect. Open the socket from the app's own pages, or list the page's origin in `cors.origin`. See [WebSockets](websockets.md#connecting).

### IL3007
**Cross-site request with the session cookie (403).** A browser sent a request that changes data (POST, PUT, PATCH or DELETE) with the session cookie of Better Auth (`betterAuthSession`), Auth.js (`authJsSession`) or express-session with Passport (`passportSession`) from a page of another site (`Sec-Fetch-Site: cross-site` or `same-site`, or an `Origin` that is neither the app's own host nor trusted). Without this check, another site could act for a signed-in user. Send the request from the app's own pages, or add the page's origin to `trustedOrigins` (`betterAuthSession(auth, { trustedOrigins: ["https://admin.example.com"] })`, Better Auth's own `trustedOrigins`, `authJsSession(Auth, config, { trustedOrigins })` or `passportSession({ trustedOrigins })`). Scripts and mobile apps can send `Authorization: Bearer <token>` (Better Auth's `bearer()` plugin), which is not checked. See [Better Auth](auth.md#better-auth), [Auth.js](auth.md#authjs) and [Passport.js](auth.md#passportjs).

### IL3008
**Identity provider keys unavailable (503).** A request sent an access token, and `jwt()` could not load the identity provider's signing keys (its OpenID configuration or key set did not answer, answered an error, or was not a JSON Web Key Set), with none cached from before. The token may be valid; it cannot be checked. Make sure the server can reach the provider (the `issuer`'s `/.well-known/openid-configuration` and its `jwks_uri`, or `jwksUrl`), and that the `issuer` matches the `issuer` field of that configuration exactly. Keys that were loaded once keep working while the provider is unreachable. See [Access tokens](auth.md#access-tokens-from-an-identity-provider-jwt).

### IL3009
**Single sign-on could not be completed (400).** The `oidc()` callback refused what came back from the identity provider: the sign-in was not started in this browser or is older than 10 minutes (the pending sign-in cookie is missing or expired), the `state` does not match, the answer names another provider (`iss`), the provider answered an `error` (such as `access_denied`) or refused the code (used or expired), or the ID token is not valid for this app (signature, issuer, audience, expiry or nonce). Nobody is signed in. Start the sign-in again from the app's login link (`/auth/login`), in the same browser. If it keeps failing, check the `issuer`, `clientId` and the redirect URI registered at the provider (`<app URL>/auth/callback`, or `redirectUri`). See [Single sign-on](auth.md#single-sign-on-with-openid-connect).

### IL3010
**Identity provider unavailable for single sign-on (502).** `oidc()` could not load the provider's OpenID configuration (`<issuer>/.well-known/openid-configuration`, whose `issuer` must match exactly), its token endpoint did not answer, or the provider refused the app's client id or secret (`invalid_client`). The log has the cause. Check that the server can reach the provider and that `issuer`, `clientId` and `clientSecret` are the ones the provider shows for this app. See [Single sign-on](auth.md#single-sign-on-with-openid-connect).

### IL3011
**Account may not sign in (403).** The identity provider signed the user in, but `oidc({ userId })` returned `null` for them (an unknown or unverified email, a user who is not allowed in), so no session was started. Give the user access in the app, or change `userId`. See [Single sign-on](auth.md#single-sign-on-with-openid-connect).

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
**Invalid tool.** A `tool(name, { description, input }).handle(fn)` definition is not usable: the name must be letters, digits, `_` and `-`, starting with a letter, at most 64 characters (what providers accept); `description` must say what the tool does; `input` must be a `t.object({ ... })` schema, or an object schema from a Standard Schema library with JSON Schema support (`z.object({ ... })` from zod 4.2+, `type({ ... })` from arktype 2.1.28+, `toStandardJsonSchema(v.object({ ... }))` from `@valibot/to-json-schema`); `handle` needs a function. Also raised when two tools in one `ai.generate` call have the same name.

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

### IL5025
**Invalid hapi inferloPlugin options.** `server.register({ plugin: inferloPlugin, options })` from `@browserlessapi/inferlo/hapi` needs `options` with `ai` (an AI client, for `server.ai` and `request.ai`), `app` (an Inferlo app from `createApp`) or both. The path prefix comes from hapi, not from the options: `server.register({ plugin: inferloPlugin, options: { app }, routes: { prefix: "/api" } })`. `server.ai` can only be set once, so register the plugin with `{ ai }` once and with `{ app }` for each app you serve. See [hapi](integrations.md#hapi).

### IL5026
**Invalid toAzureHandler() arguments or request.** `toAzureHandler(app, { prefix })` from `@browserlessapi/inferlo/azure` needs the app returned by `createApp`; the only option is `prefix`, which starts with `/` (such as `"/api"`, Azure's default route prefix). The handler only takes HTTP trigger requests: register it with `azure.http(name, { route: "{*path}", handler })`. Other triggers such as queues, timers or blobs need their own handler. See [Azure Functions](integrations.md#azure-functions).

### IL5027
**Unknown stream format.** `ai.stream(...).toResponse({ format })` takes `"sse"` (the default: Inferlo's `text` and `done` events) or `"ai-sdk"` (the AI SDK UI message stream protocol, for `useChat`). See [Chat UIs with the Vercel AI SDK](ai.md#chat-uis-with-the-vercel-ai-sdk-usechat).

### IL5028
**Invalid toAstroHandler() arguments.** `toAstroHandler(app, { prefix })` from `@browserlessapi/inferlo/astro` needs the app returned by `createApp` and, if given, a `prefix` that starts with `/`, such as `"/api"` for `src/pages/api/[...path].ts`: `export const ALL = toAstroHandler(app, { prefix: "/api" })`. The handler it returns must be exported from an endpoint file in `src/pages`, so Astro calls it with an API context. See [Astro](integrations.md#astro).

### IL5029
**Not an AI SDK provider, or an unsupported one.** `aiSdk(provider)` takes a Vercel AI SDK provider, such as `createOpenAI({ apiKey })` from `@ai-sdk/openai` or the default `mistral` instance from `@ai-sdk/mistral`, not a model (`openai("gpt-5")`): the model id goes in the alias, `"openai:gpt-5"`. Its language and embedding models must use specification v2, v3 or v4 (`@ai-sdk/*` packages for `ai` 5 and later); upgrade older provider packages. Also raised for an embedding call on a provider without embedding models, and for a `name` option that is not 1 to 64 letters, digits, dots, dashes or underscores. See [Any Vercel AI SDK provider](ai.md#any-vercel-ai-sdk-provider).

### IL5030
**Invalid LangChain integration arguments.** `toLangChainModel(ai, { model, for, temperature, maxTokens })` from `@browserlessapi/inferlo/langchain` needs Inferlo's AI client (`ctx.ai`, `app.ai`, or what `createAI()` returns) and takes only those options. `toLangChainTools(tools, { ai })` takes an array of function tools made with `tool(name, ...).handle(fn)` and routes (routes need `{ ai: ctx.ai }`, otherwise IL5009). Tools bound with `bindTools` need a name. See [LangChain.js](integrations.md#langchainjs).

### IL5031
**toNodeUpgradeHandler needs Bun 1.4 or later.** On Bun 1.3, Bun's `node:http` never sends what is written to an upgraded socket, so a WebSocket handshake through `toNodeUpgradeHandler` would hang. On Bun 1.3, serve WebSocket routes with `app.listen()`, `serve(app)` or `Bun.serve({ fetch: app.fetch, websocket: bunWebSocket })` (Bun's own WebSocket server), or update Bun. See [WebSockets](websockets.md#servers).

### IL5032
**Invalid structured output schema.** `ai.generate({ output })` takes an Inferlo schema (`t.object({ ... })`) or a [Standard Schema](https://standardschema.dev) that implements Standard JSON Schema, because the model must be shown the shape: `z.object({ ... })` from zod 4.2 or later, `type({ ... })` from arktype 2.1.28 or later, or `toStandardJsonSchema(v.object({ ... }))` from `@valibot/to-json-schema` 1.5 or later (a plain Valibot schema has no JSON Schema). The schema must be expressible as JSON Schema: no dates as `Date` objects (use strings), functions or input-side transforms. The call is rejected before any model is called. See [Zod, Valibot and ArkType schemas](ai.md#zod-valibot-and-arktype-schemas).

### IL5033
**Invalid OpenAI Agents SDK arguments.** `toOpenAIAgentsModel(ai, { model, for })` from `@browserlessapi/inferlo/openai-agents` needs Inferlo's AI client (`ctx.ai`, `app.ai` or `createAI()`) and takes only `model` and `for` (set temperature and token limits with the agent's `modelSettings`); `toOpenAIAgentsTools([...], { ai })` takes Inferlo function tools and routes. Agents that run on `toOpenAIAgentsModel` cannot use OpenAI's hosted tools (web search, file search, code interpreter), which only OpenAI's own models run: use function tools, or give that agent an OpenAI model. See [OpenAI Agents SDK](integrations.md#openai-agents-sdk).

### IL5034
**Invalid Mastra arguments.** `toMastraModel(ai, { model, for })` from `@browserlessapi/inferlo/mastra` needs Inferlo's AI client (`ctx.ai`, `app.ai` or `createAI()`) and takes only `model` and `for` (set temperature and token limits with the agent's `modelSettings`); `toMastraTools([...], { ai })` takes an array of Inferlo function tools and routes. Agents that run on `toMastraModel` cannot use provider tools (such as OpenAI's web search), which only that provider's own models run: use function tools, or give that agent the provider's model. Messages can carry images (PNG, JPEG, GIF and WebP) but no other files, and an image given as base64 or bytes needs its media type. See [Mastra](integrations.md#mastra).

### IL5035
**Invalid AI SDK model or tools arguments.** `toAISdkModel(ai, { model, for })` needs Inferlo's AI client (`ctx.ai`, `app.ai` or `createAI()`) and takes only `model` and `for` (set temperature and token limits in the `generateText()` call); `toAISdkTools([...], { ai })` takes an array of Inferlo function tools and routes. Calls through `toAISdkModel` cannot use provider tools (such as OpenAI's web search), which only that provider's own models run, and messages can carry images (PNG, JPEG, GIF and WebP) but no other files; an image given as base64 or bytes needs its media type. See [Inferlo models in AI SDK Core](ai.md#inferlo-models-in-ai-sdk-core-generatetext-streamtext-agents).

### IL5036
**Invalid toTanStackHandlers() arguments.** `toTanStackHandlers(app, { prefix })` from `@browserlessapi/inferlo/tanstack-start` needs the app returned by `createApp` and, if given, a `prefix` that starts with `/`, such as `"/api"` for `createFileRoute("/api/$")`: `export const Route = createFileRoute("/api/$")({ server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) } })`. The handlers it returns must be a server route's `handlers`, so TanStack Start calls them with `{ request }`. See [TanStack Start](integrations.md#tanstack-start).

### IL5037
**Invalid LlamaIndex model or tools arguments.** `toLlamaIndexLLM(ai, { model, for, temperature, maxTokens, contextWindow })` and `toLlamaIndexEmbedding(ai, { model, for, batchSize })` from `@browserlessapi/inferlo/llamaindex` need Inferlo's AI client (`ctx.ai`, `app.ai` or `createAI()`) and take only those options (`batchSize` is a whole number above 0); `toLlamaIndexTools([...], { ai })` takes an array of Inferlo function tools and routes. The LLM takes text and images (PNG, JPEG, GIF and WebP) in system, user and assistant messages, and no `responseFormat`: for structured output, call `ai.generate({ model, prompt, output: schema })`. See [LlamaIndex.TS](integrations.md#llamaindexts).

### IL5038
**Invalid rag() table or options.** `rag(table, { ai, model, textField, vectorField, chunk })` takes a table client (`db.doc_chunks`) whose model has a text field (`text`, or the one named by `textField`) and a `t.vector()` field (the only one, or `vectorField`), and an AI client (`ctx.ai`, `app.ai` or `createAI()`). `chunk.maxChars` is a whole number from 50 to 100000 and `chunk.overlap` at most half of it. `add({ text, fields })` takes the text as a string, `fields` without the text and vector fields (rag fills them in), and makes at most 1000 chunks per call. `search({ query, where, limit, maxDistance })` takes a non-empty query, a `limit` from 1 to 100 and a `maxDistance` from 0 to 2. See [Retrieval (RAG)](ai.md#retrieval-rag).

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
**Invalid rate limit configuration.** `rateLimit` needs `max` (a whole number of at least 1), `per` (`"second"`, `"minute"`, `"hour"` or `"day"`) and optionally `by` (`"user"`, `"tenant"` or `"ip"`); `createApp({ rateLimit: { store } })` takes `"memory"`, `"database"`, `"redis"` (which needs `createApp({ redis })`, IL6031) or a BullMQ queue with `bullmqJobStore(queue, worker)` from `@browserlessapi/inferlo/bullmq`.

### IL6008
**Rate limit store "database" needs Postgres.** Use `postgres()` for `createApp({ db })`, or the default `"memory"` store.

### IL6009
**Invalid job.** A job name must be lowercase letters, digits and dashes, starting with a letter (`"send-email"`), unique in the app, with `input` a schema and `retries` a whole number from 0 to 25. `enqueue(..., { runAt })` needs a valid `Date`.

### IL6010
**Job is not registered.** The job passed to `jobs.enqueue` (or a queued job's name) is not in `createApp({ jobs: [...] })`. Pass a value made with `job(...).handle(...)` and register it, or its module.

### IL6011
**Invalid job queue configuration.** `createApp({ jobQueue: { store } })` takes `"memory"` (the default), `"database"`, `"redis"` (which needs `createApp({ redis })`, IL6031) or a BullMQ queue with `bullmqJobStore(queue, worker)` from `@browserlessapi/inferlo/bullmq`.

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
**Audit log not available or used wrongly.** `ctx.audit(action, entry)` in a route or job needs the built-in `AuditLog` model in `createApp({ models: [...models, AuditLog] })` (run `inferlo db migrate` to create the `audit_log` table), an action name such as `"tickets.update"`, and an object as `entry`, whose `tenantId`, when given, is a tenant id (a non-empty string of at most 200 characters) or `null`. See [Audit log](auth.md#audit-log).

### IL6028
**Invalid cache options or cache call.** `createApp({ cache })` takes `{ store: "memory" }` (the default, with an optional `maxEntries`, a whole number of at least 1), `{ store: "database" }`, which needs `postgres()` as the database, or `{ store: "redis" }`, which needs `createApp({ redis })` (IL6031). Cache calls need a key of 1 to 512 characters, `{ ttlMs }` with a whole number of milliseconds from 1 to 365 days, tags that are strings of 1 to 256 characters, and a value that can be stored as JSON (not `undefined`, a function or a `BigInt`; cache `null` for "nothing"): `await cache.getOrSet("tickets:stats", { ttlMs: 60_000, tags: ["tickets"] }, compute)`. The route option `cache` only works on GET routes and takes `{ ttlMs, by: "user" | "tenant" | "public", tags }`: `route.get("/tickets/stats", { cache: { ttlMs: 60_000, tags: ["tickets"] } })`. See [Caching](caching.md).

### IL6029
**Invalid sessions() options or call.** `sessions({ secret, user })` needs a `secret` of at least 32 characters (or a list of them for rotation, newest first; generate one with `openssl rand -base64 32` and keep it in `config({ secrets })`) and a `user({ userId, issuedAt }, { db })` function that loads the signed-in user. `maxAgeMs` is a whole number of milliseconds from 1 minute to 400 days, `cookie.name` a valid cookie name, `cookie.sameSite` `"lax"` or `"strict"`, and `cookie.domain` and `cookie.path` strings without spaces, commas or semicolons. `session.signIn(ctx, userId)` and `session.signOut(ctx)` need the route's context and a non-empty user id. See [Cookie sessions](auth.md#cookie-sessions).

### IL6030
**Invalid tracing options.** `createApp({ tracing })`, `createAI({ tracing })` and `serviceClient({ tracing })` take `{ api }` with the OpenTelemetry API (`import * as otel from "@opentelemetry/api"`, then `tracing: { api: otel }`) and an optional non-empty `tracerName`. Install `@opentelemetry/api` 1.3 or newer, and start an OpenTelemetry SDK so the spans are exported. See [Tracing](observability.md#tracing-opentelemetry).

### IL6031
**Redis client missing or invalid.** `createApp({ redis })` takes a connected Redis client with a `sendCommand` method: `const redis = await createClient({ url: process.env.REDIS_URL }).connect()` from the `redis` package (node-redis 5 or newer), or an ioredis client wrapped as `{ sendCommand: (args) => ioredis.call(args[0], ...args.slice(1)) }`. `rateLimit: { store: "redis" }`, `cache: { store: "redis" }` and `jobQueue: { store: "redis" }` need `createApp({ redis })`. See [Redis](redis.md).

### IL6032
**Invalid event or event subscription.** `event(name, { payload, summary })` needs a name of lowercase words of letters, digits and dashes separated by dots (`"order.paid"`) and a payload schema; retries belong to the jobs. `on(event, job)` needs an event and a job whose input accepts the payload: use `input: orderPaid.payload`, or an object with some of its fields. In one app, each event name has one definition (export it once and import it), and each job is subscribed to an event once. `events.publish(event, payload, { id })` takes an id of 1 to 200 characters. See [Events](jobs.md#events).

### IL6033
**Invalid events option or transport.** `createApp({ events })` takes `{ transport }`, either `"redis"` (Redis Streams, which needs `createApp({ redis })`, IL6031, and a `name`, because each service reads as its own consumer group named after the app) or an object that implements `EventTransport`: `{ name, send(message), receive(names, deliver) }`. Example: `createApp({ name: "billing", redis, events: { transport: "redis" } })`. See [Events between services](jobs.md#between-services).

### IL6034
**A received event was dropped.** An event from the transport did not match this service's payload schema, so its jobs were not queued; the log line names the event, its id and the problem (not the payload). Delivering it again cannot help, so it is acknowledged. Publish and subscribe with the same event definition, from a shared package, and change payloads compatibly (add optional fields only). See [Events between services](jobs.md#between-services).

### IL6035
**Invalid WebSocket route.** The `message` option of `route.ws(path, { message })` must be a schema: `route.ws("/chat", { message: t.object({ text: t.string() }) })`. Leave it out to accept any JSON message. See [WebSockets](websockets.md).

### IL6036
**Invalid `sockets` option.** `createApp({ sockets })` takes `{ transport: "redis", subscriber }`, which needs `createApp({ redis })`, a `name` (the instances of an app share one channel named after it), and a `subscriber`: a second connected Redis client with `subscribe` and `unsubscribe`, not the `redis` client itself, because a subscribed client cannot send other commands. With the `redis` package: `sockets: { transport: "redis", subscriber: await redis.duplicate().connect() }`. See [WebSocket broadcasts](redis.md#websocket-broadcasts).

### IL6037
**No file storage configured.** `ctx.storage` (or `app.storage`) was used, but `createApp` has no `storage` option, so Inferlo does not know where to keep files. Choose a store: `createApp({ storage: diskStorage({ dir: "./uploads" }) })`, or `memoryStorage()` in tests. See [File storage](storage.md).

### IL6038
**Invalid `storage` option.** `createApp({ storage })` takes a store: `diskStorage({ dir })` (which needs a non-empty `dir`), `memoryStorage()`, or your own object with a `name`, `put(key, bytes, type)`, `get(key)` and `delete(key)`. Example: `createApp({ storage: diskStorage({ dir: env("UPLOADS_DIR", { default: "./uploads" }) }) })`. See [File storage](storage.md#stores).

### IL6039
**Invalid storage key, media type, data or link expiry.** Storage keys are segments of letters, digits, `.`, `_` and `-` separated by `/`, up to 1024 characters, and no segment may be empty or start with `.`, so `..`, a leading `/` and hidden files are refused before any store sees them. Build keys from ids you control, never from a file name the client sent: `` storage.put(`avatars/${user.id}.png`, body.avatar) ``. The `type` must be a plain media type such as `image/png`, and the data a `File`, `Blob`, `Uint8Array`, `ArrayBuffer` or string. The `expiresIn` of `storage.url(key, { expiresIn })` is required, a whole number of seconds from 1 to 604800. See [File storage](storage.md#the-api).

### IL6040
**Invalid `validateResponses` option.** `createApp({ validateResponses })` takes `"warn"` (log mismatches once per route, the default outside production), `"error"` (answer 500 IL2016, for tests) or `false` (no check, the default in production). See [Response validation](routes.md#response-validation).

### IL6041
**Invalid Better Auth integration arguments.** `betterAuthSession(auth, { user, trustedOrigins, roles, tenant })` from `@browserlessapi/inferlo/better-auth` needs the instance `betterAuth({ ... })` returns, and takes only those options: `user`, `roles` and `tenant` are functions, and `trustedOrigins` is a list of origins without a path (`"https://admin.example.com"`). Better Auth's `basePath` must be a path under the root, such as the default `"/api/auth"`, so the app's own routes stay reachable. See [Better Auth](auth.md#better-auth).

### IL6042
**Invalid `jwt()` options.** `jwt({ issuer, audience, jwksUrl, secret, algorithms, user, clockToleranceSeconds, cacheMs, roles, tenant })` needs the `issuer` (the `iss` claim of the provider's tokens) and the `audience` (this API's identifier at the provider, required so tokens issued for other APIs are refused). The issuer (when keys are discovered from it) and `jwksUrl` must use https, except on localhost. `secret` is at least 32 characters, cannot be combined with `jwksUrl`, and goes with HS256, HS384 or HS512 only; the asymmetric algorithms need keys. `clockToleranceSeconds` is 0 to 300, `cacheMs` 60000 to 86400000, and `user`, `roles` and `tenant` are functions. See [Access tokens](auth.md#access-tokens-from-an-identity-provider-jwt).

### IL6043
**Invalid Auth.js integration arguments.** `authJsSession(Auth, config, { user, trustedOrigins, roles, tenant })` from `@browserlessapi/inferlo/authjs` needs `Auth` from `@auth/core` first and the Auth.js configuration (with its `providers`) second, and takes only those options: `user`, `roles` and `tenant` are functions, and `trustedOrigins` is a list of origins without a path. The configuration's `basePath` must be a path under the root, such as the default `"/auth"`, so the app's own routes stay reachable. See [Auth.js](auth.md#authjs).

### IL6044
**Auth.js session cannot be used (500).** Either the Auth.js session has no user id (Auth.js leaves it out unless the configuration adds it: `callbacks: { session: ({ session, token }) => ({ ...session, user: { ...session.user, id: token.sub } }) }`, or `({ session, user })` with database sessions), or Auth.js answered an error for the session (its log says what is wrong: often the `secret`, `trustHost` or `basePath`). Add the id in `callbacks.session`, or map the session yourself with `authJsSession(Auth, config, { user: (session) => ... })`. See [Auth.js](auth.md#authjs).
### IL6045
**Invalid Passport.js integration options.** `passportSession({ user, trustedOrigins, roles, tenant })` from `@browserlessapi/inferlo/passport` takes only those options: `user`, `roles` and `tenant` are functions, and `trustedOrigins` is a list of origins without a path (`"https://admin.example.com"`). See [Passport.js](auth.md#passportjs).

### IL6046
**Passport user cannot be used (500).** Either the app was not given an Express (or node:http) request, so there is no `req.user` to read (mount it after Passport: `server.use(passport.session()); server.use("/api", toNodeHandler(app))`; `app.listen()` and `app.fetch()` have no Express request), or Passport's user has no `id` (make `deserializeUser` return the user with its id, or map it yourself: `passportSession({ user: (u) => ({ id: String(u.userId), roles: [] }) })`). See [Passport.js](auth.md#passportjs).

### IL6047
**Invalid `oidc()` options.** `oidc({ issuer, clientId, clientSecret, session, userId, redirectUri, scopes, basePath, authorizationParams, postLogoutRedirectUri })` needs the `issuer` (https, except on localhost), the `clientId`, the `session` from `sessions()` the sign-in ends in, and a `userId(claims, { db })` function; `clientSecret` is a non-empty string or left out for a public client, `redirectUri` is an https URL, `scopes` is a list of scope names, `basePath` a path such as `"/auth"`, `authorizationParams` an object of string values that does not set the flow's own parameters (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`, `response_mode`, `request`, `request_uri`), and `postLogoutRedirectUri` an https URL. At sign-in, `userId` must return the user's id as a non-empty string or `null`. See [Single sign-on](auth.md#single-sign-on-with-openid-connect).

### IL6048
**Invalid `s3Storage()` options.** `s3Storage({ bucket, region, accessKeyId, secretAccessKey, sessionToken, endpoint, pathStyle, timeoutMs })` needs an S3 bucket name (3 to 63 lowercase letters, digits, `.` and `-`), a region (`"eu-central-1"`, or `"auto"` on Cloudflare R2) and a non-empty access key id and secret, and takes only those options. `endpoint` is the store's origin (`"https://<account id>.r2.cloudflarestorage.com"`), https except on localhost, without a path, query or credentials; `pathStyle` is `true` or `false` (bucket names with dots need `pathStyle: true` on https); `timeoutMs` is 1000 to 300000. See [S3, R2 and MinIO](storage.md#s3-r2-and-minio).

### IL6049
**S3 request failed (502).** The object store refused a request from `s3Storage()` or did not answer in time. The message names the operation (`PutObject`, `GetObject`, `HeadObject`, `DeleteObject`), the key, the bucket and S3's error code: `AccessDenied` (the key may not use the bucket: grant `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`), `NoSuchBucket` (wrong bucket, region or endpoint), `SignatureDoesNotMatch` or `InvalidAccessKeyId` (wrong secret or key id), `RequestTimeTooSkewed` (the server clock is off), `InvalidToken` or `ExpiredToken` (renew temporary credentials). Credentials never appear in the message. See [S3, R2 and MinIO](storage.md#s3-r2-and-minio).

### IL6050
**The store has no signed URLs.** `storage.url(key, { expiresIn })` needs a store that signs download URLs, such as `s3Storage()`; `memoryStorage()` and `diskStorage()` cannot. Serve those files from a route (`return new Response(await storage.get(key))`), or move them to `s3Storage()`. Your own `StorageStore` can add `url(key, expiresIn)`. See [Signed download URLs](storage.md#signed-download-urls).

### IL6051
**Invalid `natsEventTransport()` arguments.** `natsEventTransport(nc, { service, stream, maxAgeMs, staleAfterMs, batch })` from `@browserlessapi/inferlo/nats` needs a connected NATS connection first (`await connect({ servers })` from `@nats-io/transport-node`) and this service's name as `service` (1 to 100 letters, digits, `-` and `_`, usually the app's `name`), and takes only those options: `stream` is a stream name of the same characters, `maxAgeMs` 60000 to 31536000000, `staleAfterMs` 1000 to 3600000 and `batch` 1 to 1000, all whole numbers. See [NATS JetStream](jobs.md#nats-jetstream).

### IL6052
**Invalid `pinoLogger()` argument.** `pinoLogger(log)` from `@browserlessapi/inferlo/pino` needs a pino logger (`pino()` from the `pino` package, a child logger, or `fastify.log`). See [Pino](observability.md#pino).

### IL6053
**A pino logger was passed to `createApp({ logger })` directly.** Pino's methods take `(object, message)`, so Inferlo's `(message, data, fields)` entries would lose the request id and the error. Wrap it: `createApp({ logger: pinoLogger(log) })` with `pinoLogger` from `@browserlessapi/inferlo/pino`. See [Pino](observability.md#pino).

### IL6054
**Invalid `rabbitmqEventTransport()` arguments.** `rabbitmqEventTransport(connection, { service, exchange, queueType, staleAfterMs, batch })` from `@browserlessapi/inferlo/rabbitmq` needs a connection from amqplib's `connect()` (promise API) first and this service's name as `service` (1 to 100 letters, digits, `-` and `_`, usually the app's `name`), and takes only those options: `exchange` is 1 to 200 letters, digits, `.`, `-` and `_` and cannot start with `amq.`, `queueType` is `"quorum"` or `"classic"`, `staleAfterMs` 1000 to 3600000 and `batch` 1 to 1000, both whole numbers. See [RabbitMQ](jobs.md#rabbitmq).

### IL6055
**`createApp({ onError })` is not a function.** Pass a function that reports the error: `createApp({ onError: (error, info) => tracker.report(error, info) })`, or `sentryOnError(Sentry)` from `@browserlessapi/inferlo/sentry`. See [Error tracking](observability.md#error-tracking-sentry).

### IL6056
**Invalid `sentryOnError()` argument.** `sentryOnError(Sentry)` from `@browserlessapi/inferlo/sentry` needs a Sentry SDK with `captureException` (`import * as Sentry from "@sentry/node"`, initialised with `Sentry.init({ dsn })`). See [Error tracking](observability.md#error-tracking-sentry).

### IL6057
**Invalid `bullmqJobStore()` arguments.** `bullmqJobStore(queue, worker)` from `@browserlessapi/inferlo/bullmq` needs a BullMQ `Queue` and a `Worker` of the same queue created without a processor and with `autorun: false` (`new Worker("inferlo", null, { connection, autorun: false })`), so only Inferlo takes the queue's jobs. See [BullMQ](jobs.md#bullmq).

### IL6058
**Invalid `idempotency` route option.** `idempotency` takes `true` or `{ ttlMs, required }` (`ttlMs` a whole number of milliseconds from 1000 to 30 days, `required` true or false), on POST, PUT, PATCH and DELETE routes only. See [Idempotency keys](routes.md#idempotency-keys).

### IL6059
**Invalid `graphqlRoute()` options.** `graphqlRoute({ query, mutation, path, auth, rateLimit, introspection, maxFields })` from `@browserlessapi/inferlo/graphql` needs `query` with at least one field; `query` and `mutation` map GraphQL field names (letters, digits and underscores, not starting with `__`) to HTTP routes made with `route.get(...)` and the other methods, whose params, query and body field names are valid GraphQL names too. `path` is a fixed path starting with `/`, `maxFields` a whole number above 0 and `introspection` true or false. Also the code of a GraphQL error when a schema from `graphqlSchema()` is executed outside `graphqlRoute()` without `graphqlContext(app, request)` as the context. In `relations`, each relation needs `model` (a model), `field` (a new field name), `route` (an HTTP route answering a list of rows, with an array argument named by `arg`, default `ids`), `from` (a field of the model) and optionally `to` (a field of the route's rows, default `id`) and `many` (true or false), and the model's rows must be answered by some field. See [GraphQL](graphql.md).

### IL6060
**Invalid `graphqlContext()` arguments.** `graphqlContext(app, request)` from `@browserlessapi/inferlo/graphql` needs the app from `createApp()` and the request your GraphQL server passes to its context function: a Web `Request` (GraphQL Yoga's `request`) or a Node.js request (Apollo Server's `req`). Use `createYoga({ schema: graphqlSchema({ ... }), context: ({ request }) => graphqlContext(app, request) })` or, with Apollo Server, `context: async ({ req }) => graphqlContext(app, req)`. See [GraphQL Yoga and other GraphQL servers](graphql.md#graphql-yoga-and-other-graphql-servers).

### IL6061
**Invalid `winstonLogger()` argument.** `winstonLogger(log)` from `@browserlessapi/inferlo/winston` needs a winston logger (`winston.createLogger({ ... })`, a child logger from `log.child({ ... })`, or the logger nest-winston provides). See [Winston](observability.md#winston).

### IL6062
**A winston logger was passed to `createApp({ logger })` directly.** Winston's methods take `(message, meta)`, so Inferlo's `(message, data, fields)` entries would lose the request id and the error. Wrap it: `createApp({ logger: winstonLogger(log) })` with `winstonLogger` from `@browserlessapi/inferlo/winston`. See [Winston](observability.md#winston).

### IL6063
**Invalid `compression` option.** `createApp({ compression })` takes `true`, `false` or `{ threshold, encodings }`: `threshold` is the smallest answer in bytes that is compressed (a whole number from 0 to 1073741824, default 1024) and `encodings` lists `"gzip"` and/or `"deflate"` once each, in order of preference. See [Response compression](deploy.md#response-compression).

### IL6064
**Invalid `ioredisClient()` or `ioredisSubscriber()` argument.** `ioredisClient(connection)` from `@browserlessapi/inferlo/ioredis` needs an ioredis 5 (or later) connection without `keyPrefix` (Inferlo prefixes its own keys; use `connection.duplicate({ keyPrefix: "" })`), and `ioredisSubscriber(second)` needs a second ioredis connection (`connection.duplicate()`): one connection cannot be both, because a subscribed connection cannot send other commands. See [ioredis](redis.md#ioredis).

### IL6065
**An ioredis connection was passed to Inferlo directly.** ioredis's own `sendCommand` takes a `Command` object and its `subscribe` takes a callback, not Inferlo's arguments, so `createApp({ redis })` and `sockets: { subscriber }` would fail on the first command. Wrap the connections: `createApp({ redis: ioredisClient(connection), sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) } })` with both from `@browserlessapi/inferlo/ioredis`. See [ioredis](redis.md#ioredis).

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

### IL4026
**Invalid model options.** The third argument of `model(name, fields, options)` is an object with one option, `tenant` (`true` or `false`): `model("projects", { ... }, { tenant: true })`.

### IL4027
**No tenant for a tenant-scoped table.** The table was made with `model(name, fields, { tenant: true })`, and this db client does not know which tenant to work for: a request without a signed-in user, a user without a tenant (`user.tenantId`, or what `auth.tenant(user)` returns, is `null` or `undefined`), or `app.db`, a job or a script. In routes, give signed-in users a tenant; elsewhere use `db.$tenant(tenantId)`, or `db.$allTenants()` to read across tenants (it cannot insert). Also raised when a tenant id is not a non-empty string of at most 200 characters.

### IL4028
**`db.$pgClient()` needs Postgres.** `$pgClient()` returns the `pg` pool (or a transaction's connection) for other libraries on the same database, such as Drizzle, so it only works with `postgres({ url })` or `postgres({ pool })` from `@browserlessapi/inferlo/postgres`. With `memory()` there is no pg client: use Inferlo models there, or a Postgres database in tests. See [Drizzle ORM](integrations.md#drizzle-orm).

### IL4029
**`postgresJsPool(sql)` needs a postgres.js `sql` instance.** `postgresJsPool` from `@browserlessapi/inferlo/postgres-js` takes the `sql` function postgres.js creates (`import postgresJs from "postgres"; const sql = postgresJs(process.env.DATABASE_URL)`), version 3.4.0 or later (it uses `sql.unsafe` and `sql.reserve`). A connection URL, a `pg.Pool` or a transaction's `sql` cannot be used: pass the app's own instance, `postgres({ pool: postgresJsPool(sql) })`. See [postgres.js](integrations.md#postgresjs).

### IL4030
**Invalid vector search.** `db.<table>.search({ vector, field, where, limit })` needs a model with a `t.vector()` field (say which one with `field` when it has several), and `vector` must be a list of exactly that field's number of finite numbers: embed the question with the same model as the stored rows. The database adapter must support vector search (`postgres()` with pgvector, or `memory()`). See [Vector search](database.md#vector-search).

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
**`inferlo worker` needs a shared job queue.** With the default in-memory queue a separate process cannot see the jobs the server enqueues. Set `createApp({ jobQueue: { store: "database" } })` with the Postgres adapter or `createApp({ redis, jobQueue: { store: "redis" } })`, or run jobs in the server process with `app.jobs.start()`.

## Internal (9xxx)

### IL9000
**Unexpected error (500).** Something threw that was not an Inferlo error. The full error is logged on the server; set `createApp({ exposeErrors: true })` in development to include the message in responses.
