# Migrate from NestJS

This guide moves an existing NestJS app (on the default Express platform) to Inferlo one route at a time. The app keeps running and keeps its URLs during the whole migration: Inferlo answers the routes you have moved, NestJS answers the rest, and both run in the same process. Nothing has to be rewritten in one go.

NestJS and Inferlo solve the same problems with different tools. NestJS uses classes, decorators and a dependency injection container; Inferlo uses plain values and functions: routes, schemas, [modules](modules.md) and `createApp`. Most NestJS concepts map one to one (see the table in step 3).

What you gain on every route you move: input validation and types from one schema (no DTO classes and no `class-validator`), routes private by default, the same error format everywhere (`ILxxxx` codes), rate limits, request timeouts, an OpenAPI document and an MCP server generated from the routes without decorators, in-process tests without `Test.createTestingModule`, and AI models through `ctx.ai`. See [comparison](comparison.md) for the bigger picture.

## 1. Add Inferlo next to NestJS

```bash
npm install @browserlessapi/inferlo
```

Create an empty Inferlo app beside your Nest code, for example in `src/inferlo/app.ts`:

```ts
// src/inferlo/app.ts
import { createApp } from "@browserlessapi/inferlo";
import { auth } from "./auth.ts";
import { tickets } from "./tickets/module.ts";

export const app = createApp({
  name: "helpdesk",
  modules: [tickets],
  auth,
  logging: { requests: true },
});
```

Mount it with `fallthrough: true` in `main.ts`, **before** `listen()` (and before `init()`):

```ts
// src/main.ts
import { NestFactory } from "@nestjs/core";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { AppModule } from "./app.module";
import { app as inferlo } from "./inferlo/app.ts";

const nest = await NestFactory.create(AppModule);
nest.use(toNodeHandler(inferlo, { fallthrough: true }));
await nest.listen(3000);
```

`nest.use()` before `listen()` puts Inferlo in front of the Nest router. With `fallthrough: true`, Inferlo answers only requests it has a route for (method and path) and its own endpoints (`/openapi.json`, `/mcp`, health and metrics); every other request goes on to Nest, which answers it as before, including Nest's own 404. A path can be split between both: when you move `POST /tickets`, `GET /tickets/:id` stays in its Nest controller until you move it too.

Inferlo reads request bodies itself, so it works whether or not Nest's body parser is on. If you would rather keep the new routes under their own path for a while, mount the app there instead: `nest.use("/v2", toNodeHandler(inferlo))`. See [toNodeHandler](integrations.md#nodejs-frameworks-tonodehandler).

On the Fastify platform, register the app with `inferloPlugin` from `@browserlessapi/inferlo/fastify` under a prefix instead (see [Fastify](integrations.md#fastify-1)).

## 2. Move one route

Before, in NestJS: a DTO class, a controller, a service and a guard.

```ts
// create-ticket.dto.ts
export class CreateTicketDto {
  @IsString() @Length(3, 200) title: string;
  @IsOptional() @IsIn(["low", "normal", "urgent"]) priority?: "low" | "normal" | "urgent";
}

// tickets.controller.ts
@Controller("tickets")
@UseGuards(AuthGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  create(@Body() dto: CreateTicketDto, @Req() req: Request) {
    return this.tickets.create({ ...dto, priority: dto.priority ?? "normal", ownerId: req.user.id });
  }
}
```

After, in Inferlo: one schema and one route.

```ts
// src/inferlo/tickets/routes.ts
import { route, t } from "@browserlessapi/inferlo";
import { ticketService } from "./service.ts";

export const createTicket = route
  .post("/tickets", {
    body: t.object({
      title: t.string().min(3).max(200),
      priority: t.enum(["low", "normal", "urgent"]).default("normal"),
    }),
    summary: "Create a ticket",
  })
  .handle(async ({ body, user, status }) => {
    status(201);
    return ticketService.create({ ...body, ownerId: user.id });
  });
```

Then remove the method from the Nest controller. Requests to `POST /tickets` now reach Inferlo, at the same URL.

- The route is private by default: `user` is the signed-in user, and requests without one get `401` (IL3001). This replaces `@UseGuards(AuthGuard)`. Add `auth: "public"` to routes anyone may call, or a role name such as `auth: "admin"` instead of a roles guard.
- The schema replaces the DTO class, `class-validator`, `class-transformer` and `ValidationPipe`: invalid input gets `422` with IL1001 and every problem listed, before the handler runs, and `body` is typed from the schema. `query` and `params` schemas replace `ParseIntPipe` and friends.
- A returned value is sent as JSON with status 200 (Nest answers `POST` with 201 by default: call `status(201)` to keep that). `undefined` sends `204`. Throw `notFound()`, `forbidden()` or `httpError(409, "...")` instead of `NotFoundException` and `HttpException`.
- The error format changes from Nest's `{ statusCode, message, error }` to Inferlo's `{ "error": { "code", "message", ... } }`. If clients parse error bodies, tell them, or move routes in groups that one client uses.

## 3. Map NestJS concepts to Inferlo

| NestJS | Inferlo |
|---|---|
| `@Module({ imports, controllers, providers, exports })` | `module("tickets", { imports, routes, jobs, models, provides })` ([modules](modules.md)), registered with `createApp({ modules })` |
| `@Controller("tickets")` with `@Get()`, `@Post()` methods | `export const x = route.get("/tickets", options).handle(fn)` in a routes file, listed in the module's `routes` |
| `@Injectable()` service, constructor injection | Plain functions or objects: import them, or list them in a module's `provides` for other modules (`tickets.provides.create(...)`). Pass `db`, `ai` and the user as arguments |
| `exports: [TicketsService]` | `provides: { create, list }` |
| DTO classes, `class-validator`, `ValidationPipe` | `t.*` schemas in `body`, `query` and `params` ([schemas](schema.md)); reuse model schemas with `Ticket.pick(...)` |
| `ParseIntPipe`, `ParseUUIDPipe` | `params: t.object({ id: t.int() })`, `t.uuid()` |
| Guards (`CanActivate`), `@Roles()` | `createApp({ auth: { resolve(req) { ... } } })` and the route's `auth` option (`"user"`, `"public"` or a role) ([auth](auth.md)) |
| `@Req() req.user` | `user` in the handler context |
| Interceptors, `NestMiddleware` | `createApp({ middleware: [async (ctx, next) => ...] })` ([middleware](routes.md#middleware)) |
| Exception filters, `HttpException` | Thrown `InferloError`s: `notFound()`, `forbidden()`, `badRequest()`, `httpError(status, message)` ([errors](routes.md#errors)) |
| `@nestjs/swagger` decorators | Generated: `GET /openapi.json`; `summary`, `description` and `tags` route options; modules become tags |
| `@nestjs/config` and `ConfigService` | `config({ schema, secrets })` in `src/config.ts` ([configuration](config.md)) |
| `@nestjs/throttler` | `rateLimit: { max: 10, per: "minute" }` on the route ([rate limiting](routes.md#rate-limiting)) |
| `@nestjs/terminus` | `createApp({ health: true })`: `/health` and `/ready` ([deployment](deploy.md)) |
| `@nestjs/schedule`, `@nestjs/bull` | `job(...)`, `cron(...)` and `inferlo worker` ([jobs](jobs.md)) |
| `enableShutdownHooks()` | `await app.close({ delayMs: 5000 })` on SIGTERM ([graceful shutdown](deploy.md#graceful-shutdown)) |
| TypeORM or Prisma | Keep it, or use Inferlo [models](database.md) for new tables (step 5) |
| `Test.createTestingModule`, `supertest` | `await app.request("/tickets", { method: "POST", json: {...}, as: user })` ([testing](testing.md)) |
| `InferloModule.forRoot({ ai })` | `ctx.ai` in every handler, configured in `createApp({ ai })` ([AI](ai.md)) |

## 4. Turn Nest modules into Inferlo modules

A Nest feature module usually becomes one Inferlo module with the same name. Services become plain functions that take what they need as arguments, so nothing is injected:

```ts
// src/inferlo/tickets/service.ts
import type { AppDb } from "@browserlessapi/inferlo";

export const ticketService = {
  create: (db: AppDb, data: { title: string; priority: "low" | "normal" | "urgent"; ownerId: string }) => db.tickets.insert(data),
  listFor: (db: AppDb, ownerId: string) => db.tickets.findMany({ where: { ownerId } }),
};
```

```ts
// src/inferlo/tickets/module.ts
import { module } from "@browserlessapi/inferlo";
import { users } from "../users/module.ts";
import * as ticketRoutes from "./routes.ts";
import { ticketService } from "./service.ts";

export const tickets = module("tickets", {
  imports: [users],          // was imports: [UsersModule]
  routes: [ticketRoutes],    // was controllers: [TicketsController]
  provides: ticketService,   // was exports: [TicketsService]
});
```

`createApp` checks the dependencies when the app starts (IL6023, IL6024), and `inferlo describe` shows each module with its imports, routes and what it provides. While both frameworks run, a Nest service and an Inferlo route can call the same plain functions, so you can move the controller first and the service later.

## 5. Share auth between both

During the migration, Nest guards and Inferlo routes must accept the same credentials. Put the check in one function and use it from both:

```ts
// src/auth-check.ts
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const session = await sessions.findByToken(token); // your existing lookup
  return session ? { id: session.userId, roles: session.roles } : null;
}
```

```ts
// NestJS guard, as before
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = await userFromToken(req.headers.authorization?.replace(/^Bearer /, ""));
    return Boolean(req.user);
  }
}
```

```ts
// src/inferlo/auth.ts
import { bearer } from "@browserlessapi/inferlo";
import { userFromToken } from "../auth-check.ts";

export const auth = bearer((token) => userFromToken(token));
```

A user needs an `id`, and `roles` for role-based routes. For cookies or other schemes, write `auth: { resolve(req) { ... } }`, reading headers from the standard `Request`.

## 6. Keep your data layer, then adopt models where they fit

Inferlo handlers can call any database code you already have (TypeORM repositories, Prisma, a query builder): import it and use it in the handler or service function. You do not have to move data access to switch routes.

For new tables, use Inferlo [models](database.md): validated inserts and updates, typed queries, relations, pagination and generated migrations (`inferlo db migrate`). Inferlo models expect a `uuid` `id`, `created_at` and `updated_at` columns and snake_case column names, so existing tables that differ are best left with your current code.

## 7. Move the tests

```ts
// Before: a testing module and supertest
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
const nest = moduleRef.createNestApplication();
await nest.init();
await request(nest.getHttpServer()).post("/tickets").set("authorization", `Bearer ${token}`).send({ title: "Printer" }).expect(201);

// After: in-process, no server, port or module compilation, signed in as a test user
import { readJson } from "@browserlessapi/inferlo/testing";

const res = await app.request("/tickets", { method: "POST", json: { title: "Printer" }, as: { id: "u1", roles: [] } });
const ticket = await readJson(res, 201);
```

End-to-end tests through the Nest app (`supertest`) keep working during the migration, because the Inferlo app is mounted in it.

## 8. Remove NestJS

When the last controller is gone, start the Inferlo app directly and remove Nest:

```ts
// src/server.ts
import { app } from "./inferlo/app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on http://localhost:${server.port}`);
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

Then remove `@nestjs/*`, `reflect-metadata`, `class-validator`, `class-transformer` and `rxjs` if nothing else uses them, and turn off `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`. Compare your app with a new project from `npx @browserlessapi/inferlo new` for the recommended layout, configuration and AGENTS.md for AI coding tools.

## Checklist

- [ ] Inferlo app mounted with `nest.use(toNodeHandler(app, { fallthrough: true }))` before `listen()`
- [ ] One auth check shared by Nest guards and Inferlo
- [ ] Each moved route: schemas for its input, the right `auth`, `status(201)` where clients expect it, the Nest method removed, a test with `app.request`
- [ ] Nest feature modules turned into Inferlo modules, services into plain functions in `provides`
- [ ] Clients told about the new error format, if they read error bodies
- [ ] NestJS removed, `app.listen()` and `app.close()` in `src/server.ts`

If you only want Inferlo's AI features inside NestJS and no migration, use `InferloModule` from [`@browserlessapi/inferlo/nestjs`](integrations.md#nestjs-1) instead.
