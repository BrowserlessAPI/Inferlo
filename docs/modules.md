# Modules

Large apps grow past one `models.ts` and one routes folder. A **module** groups one feature's models, routes and jobs, says which other modules it depends on, and names what it offers them. Modules are plain values: no decorators, no container and no injection. Other modules import the module and call what it provides directly.

```ts
// src/billing/module.ts
import { module } from "@browserlessapi/inferlo";
import { users } from "../users/module.ts";
import { Invoice } from "./models.ts";
import * as invoiceRoutes from "./routes.ts";
import * as billingJobs from "./jobs.ts";
import { createInvoice, invoiceTotal } from "./service.ts";

export const billing = module("billing", {
  description: "Invoices and payments.",
  imports: [users],                 // modules billing depends on
  models: [Invoice],                // tables billing owns
  routes: [invoiceRoutes],          // like createApp({ routes })
  jobs: [billingJobs],              // jobs, crons and on(event, job), like createApp({ jobs })
  provides: { createInvoice, invoiceTotal }, // what other modules may use
});
```

```ts
// src/app.ts
import { createApp } from "@browserlessapi/inferlo";
import { users } from "./users/module.ts";
import { billing } from "./billing/module.ts";

export const app = createApp({
  modules: [users, billing],
  // models, routes and jobs that belong to no module still go here
  auth,
  ai,
});
```

The models, routes and jobs of every module join the app's own: `app.db.invoices`, `ctx.jobs.enqueue(sendInvoice, ...)`, OpenAPI, MCP tools and `inferlo worker` work exactly as if they were passed to `createApp` directly. `app.models` lists the app's own models first, then each module's in the order of `modules`, and `app.modules` lists the modules.

## Options

| Option | What it is |
|---|---|
| `description` | One sentence about the module, shown in `describe()` and as the OpenAPI tag description |
| `imports` | Modules this module depends on. Each must also be in `createApp({ modules })` |
| `models` | The models (tables) the module owns. A model belongs to one module |
| `routes` | Routes, arrays or route files (`import * as invoiceRoutes from "./routes.ts"`) |
| `jobs` | Jobs and `cron(...)` values, arrays or job files |
| `provides` | What other modules may use, by name: functions and values |

Module names use lowercase letters, digits and dashes (`"billing"`, `"user-profiles"`). `module()` checks its options at once and throws IL6022 for a bad name, an unknown option (with a "Did you mean" hint) or a value of the wrong kind. The module and its lists are frozen.

## Using another module

Declare the dependency in `imports`, then use the other module's `provides`:

```ts
// src/billing/routes.ts
import { route, t } from "@browserlessapi/inferlo";
import { users } from "../users/module.ts";

export const createInvoice = route
  .post("/invoices", { body: t.object({ userId: t.uuid(), amountCents: t.int().min(0) }) })
  .handle(async ({ body, db }) => {
    const user = await users.provides.getUser(db, body.userId);
    return db.invoices.insert({ userId: user.id, amountCents: body.amountCents });
  });
```

Functions in `provides` take what they need as arguments (`db`, `ai`, the user), so nothing is injected behind your back and tests can call them directly. A module's `provides` is its public API: keep the rest of the module's files private to it.

## What createApp checks

When the app is created:

- every module a module `imports` is in `createApp({ modules })`, and it is the same module value (IL6023),
- module names are unique, no module is listed twice, and a model is in only one place: one module or `createApp({ models })` (IL6023),
- a model only references (`t.ref`) models of its own module, of a module it imports, or of the app itself (IL6024). An `invoices.userId` field pointing at `users` needs `imports: [users]` in the billing module.

Routes and jobs keep their usual checks: a route listed both in a module and in `createApp({ routes })` is a duplicate route (IL6001).

## Typing `db` in handlers

Register every model once, as without modules. Keep each module's models in its own file and list them all in `Register`:

```ts
// src/models.ts
import type { userModels } from "./users/models.ts";
import type { billingModels } from "./billing/models.ts";

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: [...typeof userModels, ...typeof billingModels];
    user: AppUser;
  }
}
```

Register the model arrays rather than `typeof app.models`: the app imports the routes, and the routes need the registered types, so referring to the app there would be circular. `app.db` is typed from the modules by itself (`ModuleModels<[typeof users, typeof billing]>` is the type of their models).

## describe, OpenAPI and the CLI

`app.describe()` (and `inferlo describe --json`) has a `modules` list:

```json
{
  "modules": [
    { "name": "users", "imports": [], "models": ["users"], "routes": ["GET /users/:id"], "jobs": [], "provides": ["getUser"] },
    { "name": "billing", "description": "Invoices and payments.", "imports": ["users"], "models": ["invoices"], "routes": ["POST /invoices"], "jobs": ["send-invoice"], "provides": ["createInvoice", "invoiceTotal"] }
  ]
}
```

Each model, route and job that belongs to a module also has `"module": "<name>"`. `inferlo describe` prints a Modules section and marks models and routes with `[module]`.

In OpenAPI, the routes of a module are tagged with the module's name (unless the route sets its own `tags`), and the document lists each module as a tag with its description, so API explorers group operations by feature.

## Suggested layout

```
src/
  app.ts                 createApp({ modules: [users, billing], ... })
  models.ts              Register (every module's model array)
  users/
    module.ts            module("users", { ... })
    models.ts            export const userModels = [User, ApiKey] as const
    routes.ts
  billing/
    module.ts            module("billing", { imports: [users], ... })
    models.ts
    routes.ts
    jobs.ts
    service.ts           functions listed in provides
```

Small apps do not need modules: `createApp({ models, routes, jobs })` stays the simplest way, and an app can move one feature at a time into a module.
