# Use Inferlo with other frameworks

You do not have to rewrite an existing app to use Inferlo. There are two ways in, and you can use both:

- **Use the AI module on its own:** `import { createAI } from "@browserlessapi/inferlo/ai"` in any framework (see [AI, "Use it without createApp"](ai.md)).
- **Mount a whole Inferlo app** (routes, auth, validation, OpenAPI and the MCP server) under a path of your existing app, for example `/ai`. New features can live in Inferlo while the rest of the app stays where it is.

An Inferlo app is a standard `fetch(Request) => Response` handler, so frameworks built on Web requests (Hono, ElysiaJS, Bun, Deno, Workers) mount `app.fetch` directly. Frameworks built on Node.js requests (Express, Fastify, NestJS, Koa, plain `node:http`) use `toNodeHandler(app)`.

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
- Request bodies are streamed. If a body parser already read the body (`express.json()`, `express.text()`, body-parser), Inferlo uses `req.body` instead: strings and bytes as they are, anything else as JSON (with `Content-Type: application/json`). Body size limits still apply.
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

Use `inferloPlugin` from `@browserlessapi/inferlo/fastify` (see [Fastify](#fastify-1) below): `await fastify.register(inferloPlugin, { app: inferlo, prefix: "/ai" })`.

### NestJS

```ts
const nest = await NestFactory.create(AppModule);
nest.use("/ai", toNodeHandler(inferlo)); // the Express adapter strips "/ai"
await nest.listen(3000);
```

To inject the AI client into Nest services, see [NestJS](#nestjs-1) below.

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

The [with-hono example](../examples/with-hono) uses both, and CI tests it with Hono 4.0.0 and the latest Hono.

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

fastify.post("/classify", async (request) => {
  const { object } = await request.ai.generate({ model: "fast", prompt: request.body.text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return object;
});
fastify.get("/chat", (request, reply) => reply.send(request.ai.stream({ model: "fast", prompt: request.query.q }).toResponse())); // server-sent events

await fastify.listen({ port: 3000 });
```

- `{ ai }` decorates `fastify.ai` and `request.ai` for the whole Fastify app (like plugins wrapped in `fastify-plugin`). Importing `@browserlessapi/inferlo/fastify` adds `ai` to Fastify's `FastifyInstance` and `FastifyRequest` types. Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Fastify sends the Web `Response` from `ai.stream(...).toResponse()` as it is.
- `{ app, prefix }` serves a whole Inferlo app under `prefix`: routes, auth, validation, rate limits, `/api/openapi.json` and `/api/mcp`, with Inferlo's own error format and 404s for paths under the prefix. Inferlo reads the request body itself, so forms (`application/x-www-form-urlencoded`) work and `createApp({ maxBodySize })` applies; Fastify's body parsers stay as they are for your other routes. Without `ai`, `fastify.ai` is the app's `app.ai` (unless `fastify.ai` is already set).
- A missing or invalid `prefix` (it must start with `/` and not end with `/`), an `app` that is not an Inferlo app, or neither `ai` nor `app` raise IL5015.

The [with-fastify example](../examples/with-fastify) uses both, and CI tests it with Fastify 5.0.0 (Fastify 4 reached end of life in June 2025) and the latest Fastify.

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

## Other web-standard frameworks

Bun, Deno and Workers take `inferlo.fetch` directly; see [Deployment](deploy.md).

Framework-specific helpers for AdonisJS, Ts.ED, tRPC and Encore.ts, each tested in CI against the framework's oldest supported and latest version, are on the [roadmap](../ROADMAP.md). `toNodeHandler` and `fromNodeRequest` are tested with `node:http` on Node.js and Bun.
