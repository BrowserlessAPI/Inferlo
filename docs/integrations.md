# Use Inferlo with other frameworks

You do not have to rewrite an existing app to use Inferlo. There are two ways in, and you can use both:

- **Use the AI module on its own:** `import { createAI } from "@browserlessapi/inferlo/ai"` in any framework (see [AI, "Use it without createApp"](ai.md)).
- **Mount a whole Inferlo app** (routes, auth, validation, OpenAPI and the MCP server) under a path of your existing app, for example `/ai`. New features can live in Inferlo while the rest of the app stays where it is.

An Inferlo app is a standard `fetch(Request) => Response` handler, so frameworks built on Web requests (Hono, ElysiaJS, Bun, Deno, Workers) mount `app.fetch` directly. Frameworks built on Node.js requests (Express, Fastify, NestJS, Encore.ts raw endpoints, plain `node:http`) use `toNodeHandler(app)`, hapi uses `inferloPlugin` from `@browserlessapi/inferlo/hapi`, Koa uses `toKoaMiddleware(app)`, Next.js route handlers use `toNextHandlers(app)`, Nitro, Nuxt and h3 server routes use `toH3Handler(app)`, SvelteKit rest routes use `toSvelteKitHandlers(app)`, Astro endpoints use `toAstroHandler(app)`, React Router resource routes use `toReactRouterHandlers(app)`, AWS Lambda uses `toLambdaHandler(app)`, Cloudflare Workers and Vercel Functions take `export default app`, and Netlify Functions take `export default app.fetch`.

## Node.js frameworks: toNodeHandler

```ts
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app as inferlo } from "./inferlo/app.ts";

const handler = toNodeHandler(inferlo, { prefix: "/ai" });
// handler(req, res, next?) works with node:http and every framework that passes Node requests and responses.
```

`toNodeHandler(app, { prefix })` returns an `async (req, res, next?) => void` handler:

- `prefix` is removed from the path before routing, so `GET /ai/tickets` matches `route.get("/tickets")`, `/ai/openapi.json` serves the OpenAPI document and `/ai/mcp` the MCP server. `/ai` itself is routed as `/`. Leave `prefix` out when the framework already strips the mount path (Express `app.use("/ai", ...)`).
- Requests outside the prefix (including look-alikes such as `/aix`) go to `next()` when there is one. Without `next`, they are routed with their full path, so they usually answer 404 with IL2001.
- Inferlo answers every request it routes, including its own 404 and 405 errors, with the same auth, validation, rate limits and error format as `app.fetch`.
- With `fallthrough: true`, Inferlo only answers requests it has a route for (the method and the path) and its own endpoints (OpenAPI, MCP, health, metrics, and CORS preflights of its paths); everything else goes to `next()`. Mount the app **before** the host's routes this way to move routes to Inferlo one at a time at the same URLs, even when the host keeps other methods on the same path: `nest.use(toNodeHandler(inferlo, { fallthrough: true }))`. It needs an app from `createApp` (IL5019) and a host that passes `next` (Express, NestJS on the Express platform, Connect).
- Request bodies are streamed. If a body parser already read the body (`express.json()`, `express.text()`, body-parser), Inferlo uses `req.body` instead: strings and bytes as they are, plain objects and arrays as JSON (with `Content-Type: application/json`). Any other object on `req.body` (an instance of a class, such as the body reader of an Encore raw request) is not a parsed body, and the stream is read. Body size limits still apply.
- The client address (`req.socket.remoteAddress`) is used for `rateLimit: { by: "ip" }`. Behind a proxy, set `createApp({ trustProxy: true })`.
- Responses stream (AI streaming works), several `Set-Cookie` headers are kept, and a client that disconnects aborts the request's `signal`.

### node:http

```ts
import http from "node:http";
http.createServer(toNodeHandler(inferlo)).listen(3000);
```

### Express

```ts
import express from "express";
const server = express();
server.use("/ai", toNodeHandler(inferlo)); // Express strips "/ai" from req.url
server.listen(3000);
```

For `req.ai` in your own Express routes, see [Express](#express-1) below.

### Fastify

Use `inferloPlugin` from `@browserlessapi/inferlo/fastify` (see [Fastify](#fastify-1) below): `await fastify.register(inferloPlugin, { app: inferlo, prefix: "/ai" })`, or `{ app: inferlo, fallthrough: true }` to answer the app's routes at their own URLs and leave every other request to Fastify. To move a Fastify app to Inferlo route by route at the same URLs, see [Migrate from Fastify](migrate-from-fastify.md).

### NestJS

```ts
const nest = await NestFactory.create(AppModule);
nest.use("/ai", toNodeHandler(inferlo)); // the Express adapter strips "/ai"
await nest.listen(3000);
```

To inject the AI client into Nest services, see [NestJS](#nestjs-1) below. To move a Nest app to Inferlo route by route at the same URLs, see [Migrate from NestJS](migrate-from-nestjs.md).

### WebSocket routes: toNodeUpgradeHandler

WebSocket connections do not reach request handlers: Node.js servers emit them as `"upgrade"` events. To serve the app's [WebSocket routes](websockets.md) from a server another framework created, add `toNodeUpgradeHandler` next to `toNodeHandler`, with the same `prefix`:

```ts
import { toNodeHandler, toNodeUpgradeHandler } from "@browserlessapi/inferlo";

const server = express().use("/api", toNodeHandler(inferlo)).listen(3000);   // Express
server.on("upgrade", toNodeUpgradeHandler(inferlo, { prefix: "/api" }));

fastify.server.on("upgrade", toNodeUpgradeHandler(inferlo, { prefix: "/ws" })); // Fastify
nest.getHttpServer().on("upgrade", toNodeUpgradeHandler(inferlo, { prefix: "/api" })); // NestJS
```

- Upgrades outside the prefix are left to the server's other `"upgrade"` listeners (socket.io, a dev server's live reload). Inside it, the app answers, with a 404 for paths it has no route for; with `fallthrough: true` it leaves those to other listeners too.
- The connection goes through the app's middleware, auth, permissions and rate limits like any request, and Inferlo speaks the WebSocket protocol itself (no `ws` package).
- `app.listen()` and `serve(app)` already do this.
- On Bun it needs Bun 1.4 or later: Bun 1.3's `node:http` never sends what is written to an upgraded socket, so `toNodeUpgradeHandler` raises IL5031 there; use `Bun.serve({ fetch: app.fetch, websocket: bunWebSocket })` instead.

## fromNodeRequest

`fromNodeRequest(req, { prefix?, signal? })` converts a Node request to a Web `Request` (method, URL with `https` for TLS sockets, headers, streamed or already parsed body) when you want to call `app.fetch` yourself:

```ts
const response = await inferlo.fetch(fromNodeRequest(req, { prefix: "/ai" }));
```

## Hono

Hono 4.0 and later. `@browserlessapi/inferlo/hono` has no dependency on Hono and never loads Inferlo's router, database or jobs code.

```ts
import { Hono } from "hono";
import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";
import { inferloAI, type InferloVariables } from "@browserlessapi/inferlo/hono";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

const hono = new Hono<{ Variables: InferloVariables }>();
hono.use(inferloAI(ai)); // or hono.use("/chat/*", inferloAI(ai))

hono.post("/classify", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const { object } = await c.var.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return c.json(object);
});

hono.get("/chat", (c) => c.var.ai.stream({ model: "fast", prompt: c.req.query("q") ?? "" }).toResponse()); // server-sent events
```

`inferloAI(ai)` puts the AI client on the context as `c.var.ai` (typed with `new Hono<{ Variables: InferloVariables }>()`). Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Function tools (`tool(...)`) work in `c.var.ai.generate({ tools })`; routes as tools need an Inferlo route handler (IL5009).

To mount a whole Inferlo app, use Hono's `mount`, which removes the path before calling the app:

```ts
hono.mount("/api", inferlo.fetch); // /api/tickets, /api/openapi.json, /api/mcp
```

To move a Hono app to Inferlo route by route at the same URLs, see [Migrate from Hono](migrate-from-hono.md). The [with-hono example](../examples/with-hono) uses both, and CI tests it with Hono 4.0.0 and the latest Hono.

## Express

Express 4 and 5. `@browserlessapi/inferlo/express` has no dependency on Express and never loads Inferlo's router, database or jobs code.

```ts
import express from "express";
import { anthropic, createAI, t } from "@browserlessapi/inferlo/ai";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { inferloAI, sendResponse } from "@browserlessapi/inferlo/express";

const ai = createAI({ providers: { anthropic: anthropic() }, models: { fast: "anthropic:claude-haiku-4-5" } });

const server = express();
server.use(express.json());
server.use(inferloAI(ai)); // or server.use("/chat", inferloAI(ai))

server.post("/classify", async (req, res) => {
  const { object } = await req.ai.generate({ model: "fast", prompt: req.body.text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  res.json(object);
});
server.get("/chat", (req, res) => sendResponse(res, req.ai.stream({ model: "fast", prompt: String(req.query.q ?? "") }).toResponse())); // server-sent events

server.use("/api", toNodeHandler(inferloApp)); // a whole Inferlo app: /api/tickets, /api/openapi.json, /api/mcp
server.listen(3000);
```

- `inferloAI(ai)` puts the AI client on every request as `req.ai`. Importing `@browserlessapi/inferlo/express` adds `ai` to Express's `Request` type (with `@types/express`), so `req.ai` is typed in every handler. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Function tools (`tool(...)`) work in `req.ai.generate({ tools })`; routes as tools need an Inferlo route handler (IL5009).
- `sendResponse(res, response)` sends a Web `Response` from an Express handler: status, headers (every `Set-Cookie`) and the body, streamed. Use it for `ai.stream(...).toResponse()`.
- A whole Inferlo app mounts with `toNodeHandler` (above). Express removes the mount path, so no `prefix` is needed; a body already parsed by `express.json()` is passed on.

To move an Express app to Inferlo route by route, see [Migrate from Express](migrate-from-express.md).

The [with-express example](../examples/with-express) uses all three, and CI tests it with Express 4 (the newest 4.x release, still maintained upstream) and the latest Express.

## Fastify

Fastify 5. `@browserlessapi/inferlo/fastify` has no runtime dependency on Fastify and never loads Inferlo's router, database or jobs code.

```ts
import Fastify from "fastify";
import { anthropic, createAI, t } from "@browserlessapi/inferlo/ai";
import { inferloPlugin } from "@browserlessapi/inferlo/fastify";

const ai = createAI({ providers: { anthropic: anthropic() }, models: { fast: "anthropic:claude-haiku-4-5" } });

const fastify = Fastify();
await fastify.register(inferloPlugin, { ai });                                // fastify.ai and request.ai
await fastify.register(inferloPlugin, { app: inferloApp, prefix: "/api" });   // a whole Inferlo app under /api
// or: await fastify.register(inferloPlugin, { app: inferloApp, fallthrough: true }); // only the app's routes, at their own URLs

fastify.post("/classify", async (request) => {
  const { object } = await request.ai.generate({ model: "fast", prompt: request.body.text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return object;
});
fastify.get("/chat", (request, reply) => reply.send(request.ai.stream({ model: "fast", prompt: request.query.q }).toResponse())); // server-sent events

await fastify.listen({ port: 3000 });
```

- `{ ai }` decorates `fastify.ai` and `request.ai` for the whole Fastify app (like plugins wrapped in `fastify-plugin`). Importing `@browserlessapi/inferlo/fastify` adds `ai` to Fastify's `FastifyInstance` and `FastifyRequest` types. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Fastify sends the Web `Response` from `ai.stream(...).toResponse()` as it is.
- `{ app, prefix }` serves a whole Inferlo app under `prefix`: routes, auth, validation, rate limits, `/api/openapi.json` and `/api/mcp`, with Inferlo's own error format and 404s for paths under the prefix. Inferlo reads the request body itself, so forms (`application/x-www-form-urlencoded`) work and `createApp({ maxBodySize })` applies; Fastify's body parsers stay as they are for your other routes. Without `ai`, `fastify.ai` is the app's `app.ai` (unless `fastify.ai` is already set).
- `{ app, fallthrough: true }` answers only the requests the app has a route for (method and path) and its own endpoints (OpenAPI, MCP, health, metrics and CORS preflights of its paths), from an `onRequest` hook before Fastify reads the body. Every other request goes on to Fastify's routes and its 404 handler, also other methods on a path the app has. With a `prefix`, only the app's routes under it are answered. Use it to move routes from Fastify to Inferlo one at a time at the same URLs ([Migrate from Fastify](migrate-from-fastify.md)). `onRequest` hooks added before the plugin on the root instance run for the app's requests; later hooks (`preHandler`, `onSend`) do not. `fallthrough` needs an app from `createApp` (IL5019).
- A missing or invalid `prefix` (it must start with `/` and not end with `/`; optional with `fallthrough: true`), an invalid `fallthrough`, an `app` that is not an Inferlo app, or neither `ai` nor `app` raise IL5015.

The [with-fastify example](../examples/with-fastify) uses both, and CI tests it with Fastify 5.0.0 (Fastify 4 reached end of life in June 2025) and the latest Fastify.

## hapi

hapi 21. `@browserlessapi/inferlo/hapi` has no runtime dependency on hapi and never loads Inferlo's router, database or jobs code.

```ts
import Hapi from "@hapi/hapi";
import { anthropic, createAI, t } from "@browserlessapi/inferlo/ai";
import { inferloPlugin } from "@browserlessapi/inferlo/hapi";

const ai = createAI({ providers: { anthropic: anthropic() }, models: { fast: "anthropic:claude-haiku-4-5" } });

const server = Hapi.server({ port: 3000 });
await server.register({ plugin: inferloPlugin, options: { ai } });                                     // server.ai and request.ai
await server.register({ plugin: inferloPlugin, options: { app: inferloApp }, routes: { prefix: "/api" } }); // a whole Inferlo app under /api

server.route({
  method: "POST",
  path: "/classify",
  handler: async (request) => {
    const { object } = await request.ai.generate({ model: "fast", prompt: (request.payload as { text: string }).text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  },
});

await server.start();
```

- `options: { ai }` decorates `server.ai` and `request.ai`. Importing `@browserlessapi/inferlo/hapi` adds `ai` to hapi's `Server` and `Request` types. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Register it with `{ ai }` once.
- `options: { app }` serves a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) under the prefix you register the plugin with, hapi's own `routes: { prefix: "/api" }`: the app's `/summaries` answers at `/api/summaries`, OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Without a prefix, it answers every path hapi has no route for, because hapi's own routes are more specific than its catch-all. Without `ai`, `server.ai` is the app's `app.ai` (unless it is already set).
- Inferlo reads the request body itself (hapi does not parse it for these routes), so forms work and `createApp({ maxBodySize })` applies, and writes the answer, AI streams included, to the connection. hapi's `onPreResponse` extensions and response events do not run for the app's requests; the app's own logging, metrics and tracing do.
- hapi runs on Node.js (and on Bun, where Inferlo's tests run it too). On Bun 1.3.0, hapi's own `server.inject` returns empty answers, so test over a real connection there (`await server.start()` and `fetch`).
- Options that are not an object, neither `ai` nor `app`, an `app` that is not an Inferlo app, a `prefix` in the options (use `routes: { prefix }`) or a second `{ ai }` raise IL5025.

hapi does not send Web `Response` objects, so serve routes that stream AI answers (`ai.stream(...).toResponse()`) from the Inferlo app, like `/api/chat` in the example.

The [with-hapi example](../examples/with-hapi) uses both, and CI tests it with hapi 21.1.0 (the first hapi 21 release with its own TypeScript types) and the latest hapi.

## ElysiaJS

ElysiaJS 1.0 and later, on Bun and Node.js. `@browserlessapi/inferlo/elysia` has no runtime dependency on Elysia and never loads Inferlo's router, database or jobs code.

```ts
import { Elysia } from "elysia";
import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";
import { inferloAI } from "@browserlessapi/inferlo/elysia";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

const server = new Elysia()
  .use(inferloAI(ai))
  .post("/classify", async ({ ai, body }) => {
    const { object } = await ai.generate({ model: "fast", prompt: (body as { text: string }).text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  })
  .get("/chat", ({ ai, query }) => ai.stream({ model: "fast", prompt: query.q ?? "" }).toResponse()); // server-sent events
```

`inferloAI(ai)` is an Elysia plugin that decorates the context with `ai`, typed in every handler after `.use(...)`. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Function tools (`tool(...)`) work in `ai.generate({ tools })`; routes as tools need an Inferlo route handler (IL5009).

To mount a whole Inferlo app, use Elysia's `mount`, which removes the path before calling the app:

```ts
server.mount("/api", inferlo.fetch); // /api/tickets, /api/openapi.json, /api/mcp
```

The [with-elysia example](../examples/with-elysia) uses both, and CI tests it with Elysia 1.0.0 and the latest Elysia on Node.js and Bun.

## NestJS

NestJS 11 and 12. `@browserlessapi/inferlo/nestjs` has no runtime dependency on NestJS and never loads Inferlo's router, database or jobs code.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import { anthropic, createAI, t, type AI } from "@browserlessapi/inferlo/ai";
import { INFERLO_AI, InferloModule } from "@browserlessapi/inferlo/nestjs";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

@Injectable()
export class ClassifyService {
  constructor(@Inject(INFERLO_AI) private readonly ai: AI) {}

  async classify(text: string) {
    const { object } = await this.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  }
}

@Module({ imports: [InferloModule.forRoot({ ai })], providers: [ClassifyService] })
export class AppModule {}
```

- `InferloModule.forRoot({ ai })` provides the AI client (`createAI(...)` or an Inferlo app's `app.ai`) under the token `INFERLO_AI`. The module is global by default, so every module can inject it; pass `global: false` to import it where it is needed.
- `InferloModule.forRootAsync({ imports, inject, useFactory })` creates the client when Nest starts, for example from `ConfigService`: `forRootAsync({ inject: [ConfigService], useFactory: (config) => createAI({ providers: { anthropic: anthropic({ apiKey: config.getOrThrow("ANTHROPIC_API_KEY") }) }, models }) })`.
- Anything that is not an AI client raises IL5014 (for `useFactory`, when Nest starts); missing options raise IL5016.
- In a controller, return `this.ai.stream(...).toResponse()` through `@Res()` with `sendResponse(res, response)` from `@browserlessapi/inferlo/express` to stream server-sent events.

A whole Inferlo app mounts with `nest.use("/api", toNodeHandler(inferlo))` on the Express platform (above), or with `inferloPlugin` from `@browserlessapi/inferlo/fastify` on the Fastify platform. The [with-nestjs example](../examples/with-nestjs) uses both, and CI tests it with NestJS 11.0.0 (the oldest major with security support) and the latest NestJS.

## tRPC

tRPC 11. `@browserlessapi/inferlo/trpc` has no runtime dependency on tRPC and never loads Inferlo's router, database or jobs code. It gives procedures `ctx.ai`, and turns procedures into tools a model can call.

```ts
import { initTRPC } from "@trpc/server";
import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";
import { inferloAI, trpcTools } from "@browserlessapi/inferlo/trpc";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

const trpc = initTRPC.context<{ user: { id: string } | null }>().create();
const aiProcedure = trpc.procedure.use(inferloAI(ai));

export const appRouter = trpc.router({
  classify: aiProcedure.input(t.object({ text: t.string().min(1) })).mutation(async ({ ctx, input }) => {
    const { object } = await ctx.ai.generate({ model: "fast", prompt: input.text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  }),
  chat: aiProcedure.input(t.object({ prompt: t.string() })).subscription(async function* ({ ctx, input, signal }) {
    yield* ctx.ai.stream({ model: "fast", prompt: input.prompt, signal }); // text chunks as they arrive
  }),
});
```

- `inferloAI(ai)` is a tRPC middleware: `trpc.procedure.use(inferloAI(ai))` adds `ctx.ai` (typed) next to the context your `createContext` returns. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014.
- Inferlo schemas (`t.object(...)`) work as tRPC inputs and outputs, with typed `input`. Invalid input is a `BAD_REQUEST` TRPCError whose `cause` is Inferlo's `ValidationError` (IL1001, with `issues`).
- `ai.stream(...)` is an async iterable of text chunks, so `yield*` it from a subscription (server-sent events with `httpSubscriptionLink`) or from a query or mutation read with `httpBatchStreamLink`. Pass the procedure's `signal` so the model call stops when the client goes away.

### Procedures as AI tools

`trpcTools(router, { caller, procedures })` makes tools from queries and mutations for `ai.generate({ tools })`:

```ts
const tools = trpcTools(appRouter, {
  caller: appRouter.createCaller(ctx), // the current user's context
  procedures: {
    "tickets.create": "Create a support ticket for the current user.",
    "tickets.get": "Get one ticket by id.",
  },
});
const { text } = await ai.generate({ model: "fast", prompt: "File a ticket: the printer is on fire", tools, maxSteps: 5 });
```

- Each tool is named after the procedure's path with `.` replaced by `_` (`tickets_create`), offers the procedure's `t.object` input (with `.describe()` texts) to the model, and validates the model's arguments before the call.
- Calls run through `caller`, so the procedure's middleware, auth checks and validation apply as for the user whose context made the caller.
- A TRPCError the model can act on (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS` and the other 4xx codes) goes back to the model as a failed tool result with the error's code and message; other errors, such as `INTERNAL_SERVER_ERROR`, reject `ai.generate`.
- A procedure without input takes `{}`. For a procedure whose input is not an Inferlo schema (for example Zod), give the tool its input: `"notes.add": { description: "Add a note.", input: t.object({ text: t.string() }) }`.
- An unknown path, a subscription, a missing description or an input that is not a `t.object` raises IL5017, listing every problem.

A whole Inferlo app runs next to tRPC on the same server: mount `inferlo.fetch` (Web servers) or `toNodeHandler(inferlo)` (Node servers) under its own path. The [with-trpc example](../examples/with-trpc) uses both helpers with tRPC's fetch adapter, and CI tests it with tRPC 11.0.0 (the oldest supported major; tRPC 10 is no longer maintained) and the latest tRPC.

## AdonisJS

AdonisJS 6 and 7. `@browserlessapi/inferlo/adonisjs` is an AdonisJS provider: it binds the AI client from `config/ai.ts` in the container as `ai` and adds `ctx.ai` to every HTTP context. It has no runtime dependency on AdonisJS beyond the app it runs in, and never loads Inferlo's router, database or jobs code.

```ts
// config/ai.ts
import env from "#start/env";
import { anthropic, createAI } from "@browserlessapi/inferlo/ai";

export default createAI({
  providers: { anthropic: anthropic({ apiKey: env.get("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
```

```ts
// adonisrc.ts
providers: [
  () => import("@adonisjs/core/providers/app_provider"),
  // ...
  () => import("@browserlessapi/inferlo/adonisjs"),
],
```

```ts
// start/routes.ts
import router from "@adonisjs/core/services/router";
import { t } from "@browserlessapi/inferlo/ai";

router.post("/classify", async ({ ai, request }) => {
  const { object } = await ai.generate({ model: "fast", prompt: request.input("text"), output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return object;
});
```

- `ctx.ai` and the container binding `ai` are typed: importing the provider adds `ai` to `HttpContext` and `ContainerBindings`.
- Outside an HTTP context (services, commands, queue jobs), resolve it from the container: `const ai = await app.container.make("ai")`.
- The client is checked when the app boots: a missing `config/ai.ts` raises IL5018, and a default export that is not an AI client (`createAI(...)` or an Inferlo app's `app.ai`) raises IL5014.
- To stream to the browser, write the chunks of `ai.stream(...)` to `response.response` (the Node response), or return `await ai.stream(...).text()` when you do not need streaming.

The [with-adonisjs example](../examples/with-adonisjs) boots an AdonisJS app with the provider, and CI tests it with AdonisJS 6.2.0 (the first stable 6.x; AdonisJS 6 is still maintained) and the latest AdonisJS (7, on Node.js 24).

## Ts.ED

Ts.ED 8. `@browserlessapi/inferlo/tsed` has no runtime dependency on Ts.ED and never loads Inferlo's router, database or jobs code. `inferloAI(ai)` returns a plain Ts.ED provider, and `InferloAI` is both the injection token and the type of the client.

```ts
import { Configuration, Injectable } from "@tsed/di";
import { anthropic, createAI, t } from "@browserlessapi/inferlo/ai";
import { InferloAI, inferloAI } from "@browserlessapi/inferlo/tsed";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

@Injectable()
export class ClassifyService {
  constructor(private readonly ai: InferloAI) {}

  async classify(text: string) {
    const { object } = await this.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  }
}

@Configuration({ imports: [inferloAI(ai)] })
export class Server {}
```

- `inferloAI(ai)` registers an AI client (`createAI(...)` or an Inferlo app's `app.ai`) as `InferloAI`. Put it in `@Configuration({ imports })` or in the settings of `PlatformExpress.bootstrap(Server, { imports: [inferloAI(ai)] })`. Anything that is not an AI client raises IL5014.
- Inject it with the type alone (`constructor(private readonly ai: InferloAI)`, with `emitDecoratorMetadata`), with `@Inject(InferloAI)`, or with `inject(InferloAI)`.
- To create the client when Ts.ED starts, for example from configuration, use a Ts.ED factory with the same token: `imports: [{ token: InferloAI, useFactory: () => createAI({ ... }) }]`.
- In tests, pass a client with a mock provider the same way: `PlatformTest.create({ imports: [inferloAI(createAI({ providers: { anthropic: mockProvider({ respond: () => "..." }) }, models }))] })`, or `PlatformTest.invoke(ClassifyService, [inferloAI(mockAI)])`.

A whole Inferlo app mounts on the Express platform with `toNodeHandler` in the `$beforeRoutesInit` hook, before Ts.ED's own routes:

```ts
import { PlatformApplication } from "@tsed/platform-http";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app as inferlo } from "./inferlo/app.ts";

@Configuration({ imports: [inferloAI(inferlo.ai)], middlewares: ["json-parser"] })
export class Server {
  constructor(private readonly app: PlatformApplication) {}

  $beforeRoutesInit() {
    this.app.getApp().use("/api", toNodeHandler(inferlo)); // Express strips "/api"
  }
}
```

The [with-tsed example](../examples/with-tsed) does both, and CI tests it with Ts.ED 8.0.1 (the oldest 8.x release that loads as native ES modules on Node.js) and the latest Ts.ED.

## Koa

Koa 2 and 3. `@browserlessapi/inferlo/koa` has no runtime dependency on Koa and never loads Inferlo's router, database or jobs code.

```ts
import Koa from "koa";
import { anthropic, createAI, t } from "@browserlessapi/inferlo/ai";
import { inferloAI, sendResponse, toKoaMiddleware } from "@browserlessapi/inferlo/koa";
import { app as inferlo } from "./inferlo/app.ts";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

const koa = new Koa();
koa.use(inferloAI(ai));                                   // ctx.ai in every middleware, typed
koa.use(toKoaMiddleware(inferlo, { prefix: "/api" }));    // a whole Inferlo app under /api

koa.use(async (ctx) => {
  if (ctx.path === "/classify") {
    const { object } = await ctx.ai.generate({ model: "fast", prompt: String(ctx.query.text), output: t.object({ label: t.enum(["bug", "feature"]) }) });
    ctx.body = object;
  } else if (ctx.path === "/chat") {
    await sendResponse(ctx, ctx.ai.stream({ model: "fast", prompt: String(ctx.query.q) }).toResponse()); // server-sent events
  }
});
```

- `inferloAI(ai)` puts an AI client (`createAI(...)` or an Inferlo app's `app.ai`) on every context as `ctx.ai`. Importing the entry point adds `ai` to Koa's `DefaultContext` type. Anything that is not an AI client raises IL5014.
- `toKoaMiddleware(app, { prefix, fallthrough })` takes the same options as `toNodeHandler`. With `prefix`, requests under it reach the app with the prefix removed (`/api/openapi.json`, `/api/mcp`) and everything else goes to the next middleware. With `fallthrough: true`, the app answers only the requests it has a route for and passes the rest on, so routes can move from Koa to Inferlo one at a time at the same URLs. Invalid options raise IL5019.
- Put it after a body parser or before it: when `koa-bodyparser` or `@koa/bodyparser` already read the request, Inferlo uses `ctx.request.body`; otherwise it reads the stream itself.
- `sendResponse(ctx, response)` writes a Web `Response` (status, every `Set-Cookie` header, streamed body), for AI streams.

To move a Koa app to Inferlo route by route at the same URLs, see [Migrate from Koa](migrate-from-koa.md). The [with-koa example](../examples/with-koa) does all three, and CI tests it with Koa 2 (newest 2.x, still maintained upstream) and the latest Koa.

## Next.js

Next.js 15 and 16, App Router. `@browserlessapi/inferlo/nextjs` has no runtime dependency on Next.js and never loads Inferlo's router, database or jobs code by itself.

Serve a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one optional catch-all route:

```ts
// app/api/[[...path]]/route.ts
import { toNextHandlers } from "@browserlessapi/inferlo/nextjs";
import { app } from "@/inferlo/app";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextHandlers(app, { prefix: "/api" });
```

- `toNextHandlers(app, { prefix })` returns a route handler for every HTTP method. Export all of them so CORS preflights (`OPTIONS`) and `HEAD` reach Inferlo too.
- `prefix` is the URL path of the route's folder (`"/api"` for `app/api/[[...path]]/route.ts`, including Next.js's `basePath` if you set one). It is removed before the app routes the request, so the app's `/summaries` answers at `/api/summaries`, and OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Requests outside the prefix keep their path. Without `prefix`, requests reach the app unchanged.
- Use `[[...path]]` (optional catch-all) so `/api` itself reaches the app too, and keep Next.js's own route handlers in other folders: Next.js matches more specific folders first.
- Route handlers run on the Node.js runtime by default. Behind a proxy such as Vercel's, set `createApp({ trustProxy: true })` so rate limits by IP use `X-Forwarded-For`.
- Anything that is not an app, or a `prefix` that does not start with `/`, raises IL5020.

In server actions, server components and your own route handlers, use the AI module without an app:

```ts
// app/actions.ts
"use server";
import { t } from "@browserlessapi/inferlo/ai";
import { ai } from "@/lib/ai"; // export const ai = createAI({ providers, models }) from "@browserlessapi/inferlo/ai"

export async function classify(formData: FormData) {
  const { object } = await ai.generate({
    model: "fast",
    prompt: String(formData.get("text") ?? ""),
    output: t.object({ label: t.enum(["bug", "feature", "question"]) }),
  });
  return object;
}
```

Create the client once in a server-only module (`lib/ai.ts`) so API keys never reach the browser bundle. To stream text to the browser from your own route handler, return `ai.stream({ model, prompt }).toResponse()` (server-sent events).

The [with-nextjs example](../examples/with-nextjs) does both, and CI tests it with Next.js 15 (newest 15.x, still maintained upstream) and the latest Next.js, using Next.js's own `NextRequest`.

## Nuxt, Nitro and h3

h3 1 (Nitro 2, Nuxt 3 and Nuxt 4) and h3 2 (Nitro 3). `@browserlessapi/inferlo/h3` has no runtime dependency on h3, Nitro or Nuxt and never loads Inferlo's router, database or jobs code by itself.

Serve a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one catch-all server route:

```ts
// server/routes/api/[...path].ts (in Nuxt, server/routes/api/[...path].ts or server/api/[...path].ts)
import { toH3Handler } from "@browserlessapi/inferlo/h3";
import { app } from "../../inferlo/app";

export default toH3Handler(app, { prefix: "/api" });
```

- `prefix` is the URL path of the route (`"/api"` for `server/routes/api/[...path].ts` and for Nuxt's `server/api/[...path].ts`). It is removed before the app routes the request, so the app's `/summaries` answers at `/api/summaries`, and OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Requests outside the prefix keep their path. Leave it out when h3 already removed the path, as h3 1's `app.use("/api", handler)` does.
- The handler works as it is in Nitro and Nuxt file routes and in h3 apps (`router.use("/api/**", handler)` in h3 1, `app.all("/api/**", handler)` in h3 2); you do not need `defineEventHandler` or `fromWebHandler`. Inferlo reads the request body itself, so do not call `readBody` before it.
- Keep Nitro's own server routes in other files: Nitro matches more specific routes before a catch-all. Behind a proxy, set `createApp({ trustProxy: true })` so rate limits by IP use `X-Forwarded-For`.
- Anything that is not an app, or a `prefix` that does not start with `/`, raises IL5021.

To use the AI module in your own server routes, add a Nitro plugin that puts the client on every request as `event.context.ai`:

```ts
// server/plugins/ai.ts
import { inferloAI } from "@browserlessapi/inferlo/h3";
import { ai } from "../utils/ai"; // export const ai = createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or app.ai

export default defineNitroPlugin(inferloAI(ai));
```

```ts
// server/routes/classify.post.ts
import { t } from "@browserlessapi/inferlo/ai";

export default defineEventHandler(async (event) => {
  const { text } = await readBody<{ text: string }>(event);
  const { object } = await event.context.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return object;
});
```

`event.context.ai` is typed: importing `@browserlessapi/inferlo/h3` adds `ai` to h3's `H3EventContext`. Return `event.context.ai.stream({ model, prompt }).toResponse()` to stream text to the browser (server-sent events). Anything that is not an AI client raises IL5014. Create the client in server code only, so API keys never reach the browser bundle.

The [with-nitro example](../examples/with-nitro) does both, and CI tests it with h3 1 (newest 1.x, used by Nitro 2 and Nuxt) and the latest h3.

## SvelteKit

SvelteKit 2 and 3. `@browserlessapi/inferlo/sveltekit` has no runtime dependency on SvelteKit and never loads Inferlo's router, database or jobs code by itself.

Serve a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one rest route:

```ts
// src/routes/api/[...path]/+server.ts
import { toSvelteKitHandlers } from "@browserlessapi/inferlo/sveltekit";
import { app } from "$lib/server/inferlo"; // export const app = createApp({ ... })

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, fallback } = toSvelteKitHandlers(app, { prefix: "/api" });
```

- `toSvelteKitHandlers(app, { prefix })` returns a request handler for every HTTP method and a `fallback` for any other method. Export all of them so CORS preflights (`OPTIONS`) and `HEAD` reach Inferlo too.
- `prefix` is the URL path of the route's folder (`"/api"` for `src/routes/api/[...path]/+server.ts`, including `paths.base` if you set one). It is removed before the app routes the request, so the app's `/summaries` answers at `/api/summaries`, and OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Requests outside the prefix keep their path. Without `prefix`, requests reach the app unchanged.
- `[...path]` also matches `/api` itself. Keep SvelteKit's own pages and `+server.ts` files in other folders: SvelteKit matches more specific routes first.
- The client address from your adapter (`event.getClientAddress()`) is used for rate limits by IP. Behind a proxy, set `createApp({ trustProxy: true })` (and the adapter's own setting, such as `ADDRESS_HEADER` for adapter-node) so `X-Forwarded-For` is used.
- SvelteKit's own CSRF check (`csrf.checkOrigin`, on by default) still runs first and rejects cross-site form posts; JSON requests with a bearer token are not affected.
- Anything that is not an app, or a `prefix` that does not start with `/`, raises IL5022.

To use the AI module in load functions, form actions and your own `+server.ts` files, add the handle hook that puts the client on every request as `event.locals.ai`:

```ts
// src/hooks.server.ts
import { inferloAI } from "@browserlessapi/inferlo/sveltekit";
import { ai } from "$lib/server/ai"; // export const ai = createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or app.ai

export const handle = inferloAI(ai); // or sequence(inferloAI(ai), yourHandle) from "@sveltejs/kit/hooks"
```

```ts
// src/routes/classify/+page.server.ts
import { fail } from "@sveltejs/kit";
import { t } from "@browserlessapi/inferlo/ai";
import type { Actions } from "./$types";

export const actions = {
  default: async ({ request, locals }) => {
    const text = String((await request.formData()).get("text") ?? "");
    if (!text) return fail(400, { error: "Enter a message." });
    const { object } = await locals.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    return object;
  },
} satisfies Actions;
```

`event.locals.ai` is typed: importing `@browserlessapi/inferlo/sveltekit` adds `ai` to SvelteKit's `App.Locals`, so you do not need to declare it in `src/app.d.ts`. Return `locals.ai.stream({ model, prompt }).toResponse()` from a `+server.ts` file to stream text to the browser (server-sent events). Anything that is not an AI client raises IL5014. Create the client in `src/lib/server` so SvelteKit never bundles it, or your API keys, for the browser.

The [with-sveltekit example](../examples/with-sveltekit) does both, and CI tests it with SvelteKit 2 (newest 2.x) and the latest SvelteKit, using SvelteKit's own types.

## Astro

Astro 5 and newer. `@browserlessapi/inferlo/astro` has no runtime dependency on Astro and never loads Inferlo's router, database or jobs code by itself.

Serve a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one catch-all endpoint:

```ts
// src/pages/api/[...path].ts
import { toAstroHandler } from "@browserlessapi/inferlo/astro";
import { app } from "../../lib/inferlo.ts"; // export const app = createApp({ ... })

export const prerender = false;
export const ALL = toAstroHandler(app, { prefix: "/api" });
```

- `toAstroHandler(app, { prefix })` returns one endpoint handler; export it as `ALL` so every method, including CORS preflights (`OPTIONS`) and `HEAD`, reaches Inferlo.
- `export const prerender = false` makes the endpoint run on the server for every request (Astro prerenders routes at build time unless the project uses `output: "server"`). Server-rendered routes need an adapter: `npx astro add node` (or `vercel`, `netlify`, `cloudflare`).
- `prefix` is the URL path of the endpoint's folder (`"/api"` for `src/pages/api/[...path].ts`, including `base` if you set one). It is removed before the app routes the request, so the app's `/summaries` answers at `/api/summaries`, and OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Requests outside the prefix keep their path. Without `prefix`, requests reach the app unchanged.
- `[...path]` also matches `/api` itself. Keep Astro's own pages and endpoints in other folders: Astro matches more specific routes first.
- The client address from your adapter (`context.clientAddress`) is used for rate limits by IP. Behind a proxy, set `createApp({ trustProxy: true })` so `X-Forwarded-For` is used.
- Astro's own origin check (`security.checkOrigin`) still runs first for form posts; JSON requests with a bearer token are not affected.
- Anything that is not an app, or a `prefix` that does not start with `/`, raises IL5028.

To use the AI module in pages, endpoints and actions, add the middleware that puts the client on every request as `context.locals.ai` (`Astro.locals.ai` in pages):

```ts
// src/middleware.ts
import { inferloAI } from "@browserlessapi/inferlo/astro";
import { ai } from "./lib/ai.ts"; // export const ai = createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or app.ai

export const onRequest = inferloAI(ai); // or sequence(inferloAI(ai), yourMiddleware) from "astro:middleware"
```

```ts
// src/pages/classify.ts
import type { APIRoute } from "astro";
import { t } from "@browserlessapi/inferlo/ai";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const text = String((await request.formData()).get("text") ?? "");
  if (!text) return Response.json({ error: "Enter a message." }, { status: 400 });
  const { object } = await locals.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
  return Response.json(object);
};
```

`locals.ai` is typed: importing `@browserlessapi/inferlo/astro` adds `ai` to Astro's `App.Locals`, so you do not need to declare it in `src/env.d.ts`. Return `locals.ai.stream({ model, prompt }).toResponse()` from an endpoint to stream text to the browser (server-sent events). Anything that is not an AI client raises IL5014. Import the client only from server code (middleware, endpoints, the frontmatter of server-rendered pages and actions), so Astro never bundles it, or your API keys, for the browser.

The [with-astro example](../examples/with-astro) does both, and CI tests it with Astro 5 (newest 5.x) and the latest Astro, rendering the endpoints with Astro's own container (`astro/container`).

## React Router (Remix)

React Router 7 and 8 in framework mode (the successor of Remix). `@browserlessapi/inferlo/react-router` has no runtime dependency on React Router and never loads Inferlo's router, database or jobs code by itself.

Serve a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one splat resource route:

```ts
// app/routes.ts
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx"), route("api/*", "routes/api.ts")] satisfies RouteConfig;
```

```ts
// app/routes/api.ts (a resource route: no default export)
import { toReactRouterHandlers } from "@browserlessapi/inferlo/react-router";
import { app } from "~/inferlo/app.server"; // export const app = createApp({ ... })

export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" });
```

- React Router sends GET and HEAD requests to the `loader` and POST, PUT, PATCH, DELETE and OPTIONS to the `action`; both run the app, so the answer (status, headers, body and AI streams) is the app's own `Response`.
- `prefix` is the URL path of the splat route (`"/api"` for `route("api/*", ...)`, including the app's `basename` if you set one). It is removed before the app routes the request, so the app's `/summaries` answers at `/api/summaries`, and OpenAPI and MCP at `/api/openapi.json` and `/api/mcp`. Requests outside the prefix keep their path. Without `prefix`, requests reach the app unchanged.
- Keep React Router's own pages and resource routes in other files: React Router matches more specific routes before a splat. Behind a proxy, set `createApp({ trustProxy: true })` so rate limits by IP use `X-Forwarded-For`.
- Anything that is not an app, or a `prefix` that does not start with `/`, raises IL5023.

In other loaders and actions, use the AI module without an app. Create the client in a `.server.ts` module so React Router never bundles it, or your API keys, for the browser:

```ts
// app/lib/ai.server.ts
import { createAI, anthropic, env } from "@browserlessapi/inferlo/ai";

export const ai = createAI({ providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
```

```ts
// app/routes/classify.tsx
import { data } from "react-router";
import { t } from "@browserlessapi/inferlo/ai";
import { ai } from "~/lib/ai.server";
import type { Route } from "./+types/classify";

export async function action({ request }: Route.ActionArgs) {
  const text = String((await request.formData()).get("text") ?? "");
  if (!text) return data({ error: "Enter a message." }, { status: 400 });
  const { object } = await ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
  return object;
}
```

To stream text to the browser from a resource route, return `ai.stream({ model, prompt }).toResponse()` (server-sent events) from its loader.

The [with-react-router example](../examples/with-react-router) does both, and CI tests it with React Router 7 (newest 7.x) and the latest React Router, using React Router's own data router.

## AWS Lambda

`@browserlessapi/inferlo/lambda` turns a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) into a Lambda handler. It has no dependency on the AWS SDK or any Lambda package.

```ts
// src/handler.ts
import { toLambdaHandler } from "@browserlessapi/inferlo/lambda";
import { app } from "./app.ts"; // export const app = createApp({ ... })

export const handler = toLambdaHandler(app);
```

- It takes Lambda function URL events and API Gateway events with a Lambda proxy integration: HTTP API (payload format 2.0) and REST API (payload format 1.0). It answers in the format of the event it got, so one handler works behind any of them.
- Query strings, headers (also multi-value), cookies (`event.cookies` on function URLs and HTTP APIs) and bodies (also base64 encoded) reach the app as a normal `Request`. Every `Set-Cookie` the app sends is returned on its own (`cookies` for payload 2.0, `multiValueHeaders` for 1.0). JSON, text, XML and form answers are sent as text, everything else (images, files) base64 encoded, so binary answers arrive unchanged; for binary bodies on a REST API, add `*/*` to its binary media types.
- The caller's address (`requestContext.http.sourceIp`, or `requestContext.identity.sourceIp` on a REST API) is used for `rateLimit: { by: "ip" }`. Lambda instances do not share memory, so use `createApp({ rateLimit: { store: "database" } })` (and the database queue and cache) for limits across instances.
- `prefix` removes a path before the app routes the request, for example `toLambdaHandler(app, { prefix: "/prod" })` for an HTTP API stage that is not `$default`. REST API stages are not part of `event.path`, so they need no prefix. Requests outside the prefix keep their path.
- Create the app outside the handler (as above), so warm invocations reuse it, its database pool and its AI clients.

### Streaming AI answers

With `{ streaming: true }` the handler uses Lambda response streaming, so an AI answer (`ai.stream(...).toResponse()`) reaches the browser as it is generated instead of after the last token. It needs a function URL with the `RESPONSE_STREAM` invoke mode and a Node.js runtime:

```ts
// src/stream.ts
import { toLambdaHandler } from "@browserlessapi/inferlo/lambda";
import { app } from "./app.ts";

export const handler = toLambdaHandler(app, { streaming: true });
```

The status, headers and cookies are sent first, then the body as the app writes it. `streaming: true` outside the Lambda Node.js runtime (where the `awslambda` global does not exist) raises IL5024; tests can pass `{ awslambda }` with a stand-in.

Anything that is not an app, invalid options, or an event that is not from a function URL or API Gateway (SQS, S3 or schedule events need their own handler) raise IL5024.

The [with-lambda example](../examples/with-lambda) has both handlers and an AWS SAM template (`sam build && sam deploy --guided`). The tests run the handlers with the event shapes AWS documents for function URLs, HTTP APIs and REST APIs. Lambda's Node.js runtimes (`nodejs22.x` and `nodejs24.x`) are covered by the Node.js 22 and 24 jobs in CI.

## Azure Functions

`@browserlessapi/inferlo/azure` turns a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) into an HTTP trigger handler for Azure Functions (Node.js programming model v4, `@azure/functions` 4.3.0 and newer). Inferlo has no runtime dependency on `@azure/functions`; your function app already has it.

```ts
// src/functions/inferlo.ts
import { app as azure } from "@azure/functions";
import { toAzureHandler } from "@browserlessapi/inferlo/azure";
import { app } from "../app.ts"; // export const app = createApp({ ... })

azure.setup({ enableHttpStream: true }); // stream answers, AI streams included

azure.http("inferlo", {
  route: "{*path}", // every path
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous", // Inferlo checks auth itself (routes are private unless auth: "public")
  handler: toAzureHandler(app, { prefix: "/api" }),
});
```

- Azure Functions serves HTTP functions under `/api` unless `host.json` sets `extensions.http.routePrefix`. `prefix: "/api"` removes it, so the app's `/status` route answers at `/api/status`. With `"routePrefix": ""` in `host.json`, leave `prefix` out. Requests outside the prefix keep their path.
- The app sees the caller's scheme and host (`X-Forwarded-Proto` and `Host`), query strings, headers, cookies and bodies (also binary) as a normal `Request`.
- Azure Functions keeps only one `Set-Cookie` header, so every cookie the app sets is returned in the response's `cookies` list instead, with its `Path`, `Domain`, `Expires`, `Max-Age`, `Secure`, `HttpOnly` and `SameSite` attributes (attributes Azure has no field for, such as `Partitioned`, are left out).
- `rateLimit: { by: "ip" }` uses the last `X-Forwarded-For` address, the one the Azure front end adds (without its port), so a client cannot pick its own address. Function instances do not share memory, so use `createApp({ rateLimit: { store: "database" } })` (and the database queue and cache) for limits across instances.
- `azure.setup({ enableHttpStream: true })` makes Azure send the answer as the app writes it, so an AI answer (`ai.stream(...).toResponse()`) reaches the browser token by token. Without it, Azure sends the answer when it is complete; the handler is the same in both cases.
- Create the app outside the handler (as above), so warm invocations reuse it, its database pool and its AI clients.

Anything that is not an app, an unknown option, a prefix that does not start with `/`, or a call with something other than an HTTP trigger request raise IL5026.

`@azure/functions` is a bundled CommonJS package: `import { app } from "@azure/functions"` works in ES modules, while the test helpers `HttpRequest` and `HttpResponse` come from the default export (`import azureFunctions from "@azure/functions"; const { HttpRequest } = azureFunctions`). The [with-azure example](../examples/with-azure) has the function, its `host.json`, and tests that call the handler with `HttpRequest` objects the way the Functions host does. CI tests `@azure/functions` 4.3.0 and the latest release.

## Google Cloud Run functions

Cloud Run functions (formerly Cloud Functions) call your code through the Google Cloud Functions Framework with Express-style `req` and `res`, so `toNodeHandler` serves a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from one HTTP function. Inferlo needs no extra entry point and loads nothing from the Functions Framework.

```ts
// src/index.ts
import * as functions from "@google-cloud/functions-framework";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts"; // export const app = createApp({ ... })

functions.http("inferlo", toNodeHandler(app));
```

Deploy it with `gcloud run deploy my-api --source . --function inferlo --base-image nodejs22` (or `gcloud functions deploy`), with `"main"` in package.json pointing at the built `index.js`.

- The Functions Framework reads and parses every request body before your function runs. It keeps the exact bytes in `req.rawBody`, and `toNodeHandler` (and `fromNodeRequest`) give the app those bytes with their own content type, so JSON, forms, text and binary uploads arrive unchanged and the app validates them as usual.
- Every `Set-Cookie` is sent, and AI streams (`ai.stream(...).toResponse()`) are written as they are generated.
- The whole function URL is the app. To serve it under a path, use `toNodeHandler(app, { prefix: "/api" })`.
- The socket address is Google's front end. For `rateLimit: { by: "ip" }` set `createApp({ trustProxy: true })` to use the first `X-Forwarded-For` address; clients can send that header themselves, so prefer `by: "user"` for limits that matter. Instances do not share memory, so use `createApp({ rateLimit: { store: "database" } })` or `"redis"` (and the database queue and cache) across instances.
- Create the app at module level (as above), so warm requests reuse it, its database pool and its AI clients.

To test the function as the Functions Framework runs it, use `getTestServer("inferlo")` from `@google-cloud/functions-framework/testing` after importing `src/index.ts`. The [with-cloud-run-functions example](../examples/with-cloud-run-functions) does that. CI tests Functions Framework 4.0.0 and the latest release.

## Cloudflare Workers

An Inferlo app is a Worker as it is: `export default app` makes `app.fetch` the Worker's fetch handler, with routes, auth, validation, rate limits, OpenAPI, MCP and the AI module. No adapter and no extra entry point.

```ts
// src/index.ts (wrangler.jsonc "main")
import { app } from "./app.ts"; // export const app = createApp({ ... })

export default app;
```

```jsonc
// wrangler.jsonc
{
  "name": "my-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",          // or later
  "compatibility_flags": ["nodejs_compat"]
}
```

- **Bindings.** With the `nodejs_compat` flag and a compatibility date of 2025-04-01 or later, Workers put string bindings (`vars` and secrets from `wrangler secret put`) in the environment when the Worker starts, so `config({ schema })` and `env("NAME")` read them at module level like on any other runtime, and `config` secrets stay redacted. Without the flag there is no environment, and `env()` raises IL7001. Other bindings (KV, D1, R2, Durable Objects) are not strings; read them from the `env` argument of your own fetch handler (below).
- **AI.** Providers call their APIs with `fetch`, so `ctx.ai`, `app.ai` and `createAI` from `@browserlessapi/inferlo/ai` work on Workers, including streaming with `ai.stream(...).toResponse()`, tool calls and fallback between aliases. Put provider keys in Worker secrets.
- **Client address.** `rateLimit: { by: "ip" }` uses the `CF-Connecting-IP` header, which Cloudflare sets to the caller's address (a value sent by the client is replaced). With `createApp({ trustProxy: true })` the first `X-Forwarded-For` address wins instead.
- **Background work.** `ctx.waitUntil(promise)` hands the promise to the Worker's `ctx.waitUntil`, so it finishes after the response is sent.
- **State.** Each Worker isolate has its own memory, so the default memory stores for rate limits, the cache and jobs are per isolate. The Postgres adapter and the Redis stores are not yet tested on Workers.

To use other bindings or `scheduled` events next to the app, write the handler object yourself and pass the call on:

```ts
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(app.jobs.runDue());
  },
};
```

The [with-cloudflare-workers example](../examples/with-cloudflare-workers) has the Worker, its `wrangler.jsonc`, and tests that run it in workerd (the open-source Workers runtime) through Miniflare, with Anthropic answered by a stand-in. CI runs the Workers tests on Miniflare 4.20250405.0 (the first Miniflare 4 release, with workerd from April 2025) and the latest Miniflare.

## Vercel Functions

An Inferlo app is a Vercel Function as it is: on the Node.js runtime, a default export with a `fetch` method is the web-standard handler, so `export default app` serves routes, auth, validation, rate limits, OpenAPI, MCP and the AI module. No adapter.

```ts
// api/index.ts
import { app } from "../src/app.ts"; // export const app = createApp({ ... })

export default app;
```

```json
// vercel.json: every path goes to the function
{ "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }
```

- **Paths.** The Request carries the path the client asked for, so declare routes with their public paths (`route.get("/api/notes")` for `https://example.com/api/notes`).
- **Client address.** On Vercel (where Vercel sets `VERCEL=1`), `rateLimit: { by: "ip" }` uses the `X-Real-IP` header, which Vercel sets to the caller's address (a value sent by the client is replaced). Off Vercel the header is ignored, so a client cannot choose its address. With `createApp({ trustProxy: true })` the first `X-Forwarded-For` address wins instead.
- **Background work.** `ctx.waitUntil(promise)` hands the promise to Vercel's `waitUntil` (the request context that `waitUntil` from `@vercel/functions` uses), so the function stays alive until it settles.
- **AI.** Streamed answers (`ai.stream(...).toResponse()`) stream to the client. Put provider keys in the project's environment variables; `config()` and `env()` read them.
- **State.** Instances do not share memory, so use the Postgres or Redis stores for rate limits, the cache and jobs when they must be shared.

The [with-vercel example](../examples/with-vercel) has the function, its `vercel.json`, and tests that call it with requests shaped like the ones Vercel passes. Vercel's Node.js 22 and 24 runtimes are covered by the Node.js 22 and 24 CI jobs.

## Netlify Functions

Netlify Functions 2.0 call the default export with `(request, context)`, which is the signature of `app.fetch`, so `export default app.fetch` serves the whole app:

```ts
// netlify/functions/api.ts
import { app } from "../../src/app.ts";

export default app.fetch;
export const config = { path: "/api/*" }; // the paths this function answers
```

- **Paths.** The Request carries the path the client asked for: with `path: "/api/*"`, declare routes as `route.get("/api/notes")`.
- **Client address.** `rateLimit: { by: "ip" }` uses `context.ip`, the address Netlify reports for the caller. With `createApp({ trustProxy: true })` the first `X-Forwarded-For` address wins instead.
- **Background work.** `ctx.waitUntil(promise)` hands the promise to `context.waitUntil`, so the function stays alive until it settles.
- **AI and state.** As on Vercel: streamed answers stream, provider keys come from the site's environment variables, and instances do not share memory.

The [with-netlify example](../examples/with-netlify) has the function and tests that call it the way Netlify does. Netlify Functions on Node.js 22 and 24 are covered by the Node.js 22 and 24 CI jobs.

## Encore.ts

Encore.ts needs no Inferlo entry point: an Encore raw endpoint is called with Node.js-style request and response objects, so `toNodeHandler` serves a whole Inferlo app from it, and `@browserlessapi/inferlo/ai` works in any Encore service. Nothing Encore-specific is loaded by Inferlo.

Use the AI module in a service, with the API key from an Encore secret (`encore secret set --type dev,local,pr,prod AnthropicApiKey`):

```ts
// ai/ai.ts (in the "ai" service, next to ai/encore.service.ts)
import { secret } from "encore.dev/config";
import { anthropic, createAI, type AIConfig } from "@browserlessapi/inferlo/ai";

const anthropicApiKey = secret("AnthropicApiKey");

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: anthropicApiKey() }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};
export const ai = createAI(aiConfig);
```

```ts
// ai/api.ts
import { api } from "encore.dev/api";
import { t } from "@browserlessapi/inferlo/ai";
import { ai } from "./ai.ts";

export const classify = api(
  { expose: true, method: "POST", path: "/classify" },
  async ({ text }: { text: string }): Promise<{ label: "bug" | "feature" | "question" }> => {
    const { object } = await ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    return object;
  },
);
```

Mount a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) with a raw endpoint that takes every method under a path:

```ts
// ai/api.ts
import { toNodeHandler } from "@browserlessapi/inferlo";
import { inferlo } from "./inferlo.ts"; // createApp({ routes, auth, ai: aiConfig })

export const inferloApp = api.raw({ expose: true, method: "*", path: "/inferlo/*rest" }, toNodeHandler(inferlo, { prefix: "/inferlo" }));
```

- Encore passes the full path, so set `prefix` to the endpoint's path: `POST /inferlo/summaries` runs `route.post("/summaries")`, and `/inferlo/openapi.json` and `/inferlo/mcp` serve the OpenAPI document and the MCP server.
- Leave Encore's `auth` off on this endpoint: Inferlo checks auth itself with the app's `auth`, and routes stay private unless `auth: "public"`.
- To serve the Inferlo app for every path Encore has no endpoint for, use Encore's fallback path: `api.raw({ expose: true, method: "*", path: "/!rest" }, toNodeHandler(inferlo))`. Routes then move between Encore and Inferlo at the same URLs.
- Encore's raw request has no client address, so `rateLimit: { by: "ip" }` needs `createApp({ trustProxy: true })` and the `X-Forwarded-For` header from the proxy in front of your Encore app; `by: "user"` works as it is.
- Request bodies are streamed from Encore to Inferlo, and Inferlo's responses (AI streaming included) stream back.

The [with-encore example](../examples/with-encore) does both. Its tests run the endpoints with the real `encore.dev` package and Encore's own raw request and response classes (the Encore runtime itself only exists inside the Encore CLI), and CI runs them with encore.dev 1.51.0 and the latest encore.dev.

## Vercel AI SDK UI (useChat)

Chat UIs built with `useChat` from `@ai-sdk/react` (and the Vue and Svelte versions) talk to an Inferlo route directly: `ai.stream(...).toResponse({ format: "ai-sdk" })` speaks the AI SDK UI message stream protocol, and `uiChatBody` with `fromUIMessages` reads what `useChat` sends. Works in any framework above, since it is a plain route. See [Chat UIs with the Vercel AI SDK](ai.md#chat-uis-with-the-vercel-ai-sdk-usechat). Tested with the `ai` package 5.0.0 and the latest release.

## Vercel AI SDK providers

Any AI SDK provider package (`@ai-sdk/mistral`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/azure` and the others) works as an Inferlo provider with `aiSdk(provider)`. See [Any Vercel AI SDK provider](ai.md#any-vercel-ai-sdk-provider).

## LangChain.js

`@browserlessapi/inferlo/langchain` lets LangChain agents, chains and LangGraph graphs use Inferlo's AI, and Inferlo tools:

```ts
import { createAgent } from "langchain";
import { toLangChainModel, toLangChainTools } from "@browserlessapi/inferlo/langchain";

export const assistant = route
  .post("/assistant", { body: t.object({ message: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    const agent = createAgent({
      model: toLangChainModel(ai, { model: "fast", for: user.id }),
      tools: toLangChainTools([getWeather, createTicket], { ai }),
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: body.message }] });
    return { answer: result.messages.at(-1)?.content };
  });
```

- **`toLangChainModel(ai, { model, for, temperature, maxTokens })`** is a LangChain chat model (`BaseChatModel`) that calls Inferlo's AI: the alias and its fallback models, budgets (`allow`), usage tracking (`onUsage`, with `for`), tracing and every configured provider. `invoke`, `stream` (text chunks, then one chunk with usage) and `bindTools` work; LangChain runs the agent loop and the tools, so the model returns the tool calls without running them. Answers carry `usage_metadata` and, in `response_metadata`, the model that answered and the cost. Images in human messages (`image_url` parts, or `image` parts with a URL or base64 data) reach vision models.
- **`toLangChainTools(tools, { ai })`** turns Inferlo function tools (`tool(name, ...).handle(fn)`) into LangChain tools, with the tool's schema and validation. Routes work too when you pass a request's `ctx.ai`: each call runs as the signed-in user, with the route's auth, permissions, validation and rate limits, as with `ai.generate({ tools })`. Without `ai`, a route raises IL5009.
- `bindTools` also takes LangChain tools and OpenAI-style tool definitions.
- `@langchain/core` is an optional peer dependency: install it (and `langchain` or `@langchain/langgraph` for agents) in your app. The core package never loads it. Tested with `@langchain/core` 0.3 (newest 0.3.x, maintained until December 2026) and the latest release (1.x). Invalid arguments raise IL5030.

## Drizzle ORM

An app that already uses [Drizzle](https://orm.drizzle.team) on Postgres can add Inferlo next to it, on the same database, without moving its tables. A tested example is in `examples/with-drizzle`.

**One pool for both.** Create the `pg` pool once and give it to Drizzle and to `postgres({ pool })`:

```ts
// src/db.ts
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts"; // your existing Drizzle schema

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const orm = drizzle({ client: pool, schema });

// src/app.ts
export const app = createApp({ models, db: postgres({ pool }), routes, auth });
```

**Drizzle in routes and jobs.** Import `orm` where you need it, as any module: `await orm.select().from(invoices).where(eq(invoices.customerId, id))`. Inferlo adds no wrapper, so Drizzle queries do not get `ctx.db`'s request timeout or tenant filter; keep Inferlo models (`ctx.db`) for tables that need them. Errors from Drizzle are not Inferlo errors: they answer 500 with the details logged, never sent.

**One transaction for both.** Start the transaction with Inferlo and run Drizzle on the transaction's connection, which `tx.$pgClient()` returns. Both commit together, and an error in either rolls both back:

```ts
export const createInvoice = route
  .post("/invoices", { body: t.object({ customerId: t.int(), cents: t.int().min(1), reminder: t.string().max(500) }) })
  .handle(({ body, db }) =>
    db.$transaction(async (tx) => {
      const txOrm = drizzle({ client: await tx.$pgClient<pg.PoolClient>(), schema });
      const [invoice] = await txOrm.insert(invoices).values({ customerId: body.customerId, cents: body.cents }).returning();
      const reminder = await tx.reminders.insert({ invoiceId: invoice.id, message: body.reminder });
      return { invoice, reminder };
    }),
  );
```

- `db.$pgClient()` is the `pg.Pool` outside a transaction and the transaction's `pg.PoolClient` inside `$transaction` (pass the `pg` type you need: `tx.$pgClient<pg.PoolClient>()`). Any code that takes a pg client (Drizzle, Kysely, plain `pg` helpers) can use it. With `memory()` it raises IL4028.
- Do not start the transaction with `orm.transaction(...)` and use Inferlo inside it: Inferlo would not see Drizzle's connection.

**Migrations.** Each tool manages its own tables. `inferlo db migrate` only creates, changes and drops tables of Inferlo models, never tables it did not create, so Drizzle's tables are safe. Give new Inferlo models names that Drizzle does not use, and tell drizzle-kit to leave Inferlo's tables alone with `tablesFilter` in `drizzle.config.ts` (list your Drizzle tables, or exclude Inferlo's: `tablesFilter: ["!reminders", "!inferlo_*", "!audit_log"]`), so `drizzle-kit push` never offers to drop them. Inferlo's built-in tables start with `inferlo_` (jobs, rate limits, cache, migrations) or are `audit_log`.

Inferlo models can store the id of a Drizzle row as a plain field (`invoiceId: t.int().index()`); `t.ref` points only at Inferlo models. Tested with `drizzle-orm` 0.44.0 and the latest release, on the oldest supported and the newest PostgreSQL.

## Prisma

An app that already uses [Prisma](https://www.prisma.io) on Postgres can add Inferlo next to it, on the same database, without moving its tables. Prisma 6 and 7 are supported through Prisma's `pg` driver adapter (`@prisma/adapter-pg`); with Prisma 6, use the `prisma-client` generator with `engineType = "client"`. A tested example is in `examples/with-prisma`.

**One pool for both.** Create the `pg` pool once and give it to Prisma's adapter and to `postgres({ pool })`:

```ts
// src/db.ts
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts"; // from `prisma generate`

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// src/app.ts
export const app = createApp({ models, db: postgres({ pool }), routes, jobs, auth });
```

**Prisma in routes and jobs.** Import `prisma` where you need it, as any module: `await prisma.invoice.findUnique({ where: { id }, include: { customer: true } })`. Inferlo adds no wrapper, so Prisma queries do not get `ctx.db`'s request timeout or tenant filter; keep Inferlo models (`ctx.db`) for tables that need them. Errors from Prisma are not Inferlo errors: they answer 500 with the details logged, never sent, so check for missing rows and throw `notFound()` (404, IL4001) instead of relying on `findUniqueOrThrow` in routes.

**Models side by side.** Prisma's models stay in `schema.prisma`; new tables can be Inferlo models. An Inferlo model stores the id of a Prisma row as a plain field (`invoiceId: t.int().index()`), and a handler reads both: the invoice with `prisma.invoice.findUnique(...)`, its reminders with `db.reminders.findMany({ where: { invoiceId } })`. `t.ref` points only at Inferlo models.

**Transactions.** Prisma runs `prisma.$transaction(...)` on a connection it keeps to itself, so Prisma and Inferlo cannot share one transaction through their clients. When a write must be atomic across both, start it with Inferlo and write Prisma's tables with parameterised SQL on the same transaction (`tx.$sql`); both commit together, and an error in either rolls both back:

```ts
export const createInvoice = route
  .post("/invoices", { body: t.object({ customerId: t.int(), cents: t.int().min(1), reminder: t.string().max(500) }) })
  .handle(({ body, db }) =>
    db.$transaction(async (tx) => {
      const [invoice] = await tx.$sql(
        `INSERT INTO invoices (customer_id, cents) VALUES ($1, $2) RETURNING id, cents`,
        [body.customerId, body.cents],
      );
      const reminder = await tx.reminders.insert({ invoiceId: invoice!.id as number, message: body.reminder });
      return { invoice, reminder };
    }),
  );
```

- Writes that touch only Prisma's tables keep using `prisma.$transaction(...)`; writes that touch only Inferlo's use `db.$transaction(...)`.
- Do not call `prisma` inside `db.$transaction`, or `db` inside `prisma.$transaction`, expecting one transaction: each runs on its own connection and commits on its own.
- Queue jobs that read the new rows with Prisma after `db.$transaction` returns, so they never run before the rows are committed or for rows that were rolled back.

**Migrations.** Each tool manages its own tables. `inferlo db migrate` only creates, changes and drops tables of Inferlo models, never tables it did not create, so Prisma's tables are safe. `prisma migrate deploy` applies only Prisma's own migration files, so it leaves Inferlo's tables alone. Give new Inferlo models names that Prisma does not use; Inferlo's built-in tables start with `inferlo_` (jobs, rate limits, cache, migrations) or are `audit_log`.

**Shutting down.** Close in order: `await app.close()` (stops requests and jobs), then `await prisma.$disconnect()`, then `await pool.end()`. Neither Inferlo nor Prisma ends a pool you created.

Tested with Prisma 6 (newest 6.x) on the oldest supported PostgreSQL and the latest Prisma on the newest PostgreSQL.

## TypeORM

An app that already uses [TypeORM](https://typeorm.io) on Postgres (often with NestJS) can add Inferlo next to it, on the same database, without moving its entities or tables. TypeORM 0.3 and 1.x are supported, with decorated entity classes or `EntitySchema`. A tested example is in `examples/with-typeorm`.

**Two pools, one database.** TypeORM opens its own pool from its `DataSource`; give Inferlo a `pg` pool with `postgres({ pool })` (or `postgres({ url })`). Keep the two `max` sizes together under the server's `max_connections`:

```ts
// src/db.ts
import pg from "pg";
import { DataSource } from "typeorm";
import { Account, Subscription } from "./entities.ts";

export const dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, entities: [Account, Subscription], extra: { max: 5 } });
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// src/server.ts
await dataSource.initialize();
export const app = createApp({ models, db: postgres({ pool }), routes, jobs, auth });
```

**TypeORM in routes and jobs.** Import `dataSource` where you need it: `await dataSource.getRepository(Account).findOne({ where: { id }, relations: { subscriptions: true } })`. Inferlo adds no wrapper, so TypeORM queries do not get `ctx.db`'s request timeout or tenant filter; keep Inferlo models (`ctx.db`) for tables that need them. Check for missing rows and throw `notFound()` (404, IL4001); TypeORM's own errors (such as `EntityNotFoundError` from `findOneByOrFail`) answer 500 with the details logged, never sent. In a NestJS app, `TypeOrmModule` and Inferlo's `InferloModule` sit side by side (see [NestJS](#nestjs)).

**Models side by side.** TypeORM's entities stay where they are; new tables can be Inferlo models. An Inferlo model stores the id of a TypeORM row as a plain field (`subscriptionId: t.int().index()`), and a handler reads both: the account and its subscriptions with TypeORM, their notices with `db.renewal_notices.findMany({ where: { subscriptionId: { in: ids } } })`. `t.ref` points only at Inferlo models.

**Transactions.** `dataSource.transaction(...)` runs on a connection of TypeORM's pool, so TypeORM and Inferlo cannot share one transaction through their clients. When a write must be atomic across both, start it with Inferlo and write TypeORM's tables with parameterised SQL on the same transaction (`tx.$sql`); both commit together, and an error in either rolls both back. Database errors from `tx.$sql` are Inferlo errors, so a foreign key or unique violation answers 409:

```ts
export const createSubscription = route
  .post("/subscriptions", { body: t.object({ accountId: t.int(), plan: t.enum(["team", "business"]), cents: t.int().min(1), notice: t.string().max(500) }) })
  .handle(({ body, db }) =>
    db.$transaction(async (tx) => {
      const [subscription] = await tx.$sql(
        "INSERT INTO saas_subscriptions (account_id, plan, cents) VALUES ($1, $2, $3) RETURNING id, plan, cents",
        [body.accountId, body.plan, body.cents],
      );
      const notice = await tx.renewal_notices.insert({ subscriptionId: subscription!.id as number, message: body.notice });
      return { subscription, notice };
    }),
  );
```

- Writes that touch only TypeORM's tables keep using `dataSource.transaction(...)`; writes that touch only Inferlo's use `db.$transaction(...)`.
- Do not call `dataSource` inside `db.$transaction`, or `db` inside `dataSource.transaction`, expecting one transaction: each runs on its own connection and commits on its own.
- Queue jobs that read the new rows with TypeORM after `db.$transaction` returns, so they never run before the rows are committed or for rows that were rolled back.

**Migrations.** Each tool manages its own tables. `inferlo db migrate` only creates, changes and drops tables of Inferlo models, never tables it did not create. TypeORM's `migration:generate` and `synchronize` compare only the tables of its entities, so they plan no changes to Inferlo's tables (the example tests both directions). Give new Inferlo models table names no entity uses; Inferlo's built-in tables start with `inferlo_` or are `audit_log`, and TypeORM's own table is `migrations` (or its `migrationsTableName`). Keep `synchronize: false` in production, as TypeORM recommends.

**Shutting down.** Close in order: `await app.close()` (stops requests and jobs), then `await dataSource.destroy()`, then `await pool.end()`.

Tested with TypeORM 0.3 (newest 0.3.x) on the oldest supported PostgreSQL and the latest TypeORM on the newest PostgreSQL.

## Other web-standard frameworks

Bun, Deno and Workers take `inferlo.fetch` directly: `Bun.serve({ routes, fetch: app.fetch })` serves Bun's own routes and the Inferlo app from one server; see [Deployment](deploy.md#bun). On Deno, `Deno.serve(app.fetch)`, or `export default app` for `deno serve` and Deno Deploy; see [Deployment](deploy.md#deno).

`toNodeHandler` and `fromNodeRequest` are tested with `node:http` on Node.js and Bun.
