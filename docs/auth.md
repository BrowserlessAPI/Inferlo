# Auth

Routes are private by default. Inferlo does not force a login system on you: you give `createApp` an `auth.resolve(req)` that returns the user, and Inferlo enforces route access.

```ts
createApp({
  auth: {
    async resolve(req, { db }) {
      // return the user, or null
    },
    roles: (user) => user.roles,   // optional, default user.roles ?? []
  },
});
```

If any route is private and no `auth` is configured, `createApp` throws IL3003 at startup, so a missing auth setup can never silently expose routes.

## Route access

```ts
route.get("/health", { auth: "public" })     // anyone
route.get("/me")                              // any signed-in user (default)
route.delete("/users/:id", { auth: "admin" }) // users whose roles include "admin"
```

## Permissions

Roles answer "who is this user"; permissions answer "may this user do this, to this record". Define every permission once, by name, in one file, and check it the same way in routes, AI tools and jobs:

```ts
// src/permissions.ts
import { permissions, type AppUser, type Row } from "@browserlessapi/inferlo";
import type { Ticket } from "./models.ts";

export const access = permissions({
  "reports.view": { roles: ["admin", "analyst"] },
  "tickets.update": ({ user, ticket }: { user: AppUser; ticket: Row<typeof Ticket> }) =>
    ticket.ownerId === user.id || (user.roles ?? []).includes("admin"),
});
```

- A rule is either `{ roles: [...] }` (the user has one of these roles in `user.roles`) or a function, sync or async, that receives the user and the records it needs and returns `true` or `false`. Anything else a function returns (`undefined`, a string) is a bug and raises IL6026 instead of allowing.
- Deny by default: without a user (`null` or `undefined`) every permission is denied and the rule is not called. An unknown permission name raises IL6026.
- `await access.can("tickets.update", { user, ticket })` returns `true` or `false`.
- `await access.authorize("tickets.update", { user, ticket })` returns when allowed and otherwise throws IL3004 (403), or IL3001 (401) without a user. Throw it from a handler and the client gets the error.
- The input of `can()` and `authorize()` is typed from the rule, so a missing `ticket` is a type error.

Permissions that need only the user can go on the route. Pass the permissions to `createApp` and set `permission`:

```ts
createApp({ routes, auth, permissions: access });

export const reports = route.get("/reports", { permission: "reports.view", tool: true }).handle(...);

export const updateTicket = route.patch("/tickets/:id", { body: Ticket.pick("title").partial() }).handle(async ({ params, body, user, db }) => {
  const ticket = await db.tickets.get(params.id);
  await access.authorize("tickets.update", { user, ticket });  // 403 IL3004 for other users' tickets
  return db.tickets.update(ticket.id, body);
});
```

- `permission` is checked with `{ user }` after sign-in and before rate limits, validation and the handler. It also applies when a model calls the route as a tool (`ai.generate({ tools })` and MCP), because tools run with the caller's user.
- `createApp` checks at startup that every route's permission exists, that `createApp({ permissions })` is set when a route uses one, and that no route combines `permission` with `auth: "public"` (IL6026).
- `describe()` lists the permissions and each route's `permission`, `inferlo describe` shows them, and OpenAPI marks the route with `x-inferlo-permission` and a 403 response.
- MCP `tools/list` leaves out tools whose role (`auth: "admin"`) or `permission` the caller does not have, so AI agents only see what they may use. Tools that only need a signed-in user stay listed for anonymous callers (calling one answers IL3001), and `tools/call` checks every call as before. A rule that throws while listing hides its tool.
- In jobs there is no signed-in user: pass the user's id in the job input, load the user, and call `access.authorize(name, { user, ... })` before doing the work.
- In tests, call `access.can()` directly, or send requests as a user with `app.request(path, { as: user })`.

### Typed permission names

Add the permissions to `Register` next to your models and user, and the route option `permission` only accepts their names, so a typo is a type error instead of a startup error:

```ts
// src/models.ts
import type { access } from "./permissions.ts";

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: typeof models;
    user: AppUser;
    permissions: typeof access;
  }
}

route.get("/reports", { permission: "reports.view" });   // ok
route.get("/reports", { permission: "report.view" });    // type error
route.get("/tickets/:id", { permission: "tickets.update" }); // type error: the rule needs a ticket, call access.authorize in the handler
```

Only names whose rule needs nothing but `{ user }` (roles rules and functions of the user alone) are accepted, because the route passes only `{ user }`. Use `import type` so the models file does not load the permissions at runtime. Without `permissions` in `Register`, `permission` takes any string and `createApp` still checks it at startup. The type is exported as `AppPermission`.

## Audit log

Record who changed what, from routes and jobs. Add the built-in `AuditLog` model to the app (and to `Register`) and run `inferlo db migrate`, which creates the `audit_log` table:

```ts
import { AuditLog } from "@browserlessapi/inferlo";

export const models = [User, Ticket, AuditLog] as const;   // in Register too, so ctx.db.audit_log is typed
```

Then write an entry with `audit` after each change you want on record:

```ts
export const updateTicket = route.patch("/tickets/:id", { body: Ticket.pick("title", "status").partial() }).handle(async ({ params, body, user, db, audit }) => {
  const ticket = await db.tickets.get(params.id);
  await access.authorize("tickets.update", { user, ticket });
  const updated = await db.tickets.update(ticket.id, body);
  await audit("tickets.update", { model: "tickets", before: ticket, after: updated });
  return updated;
});
```

Each entry has:

| Field | Value |
|---|---|
| `action` | The name you pass, such as `"tickets.update"` (use your permission names) |
| `userId` | The signed-in user. In jobs there is none: pass `userId` (the user who asked for the work), or leave it out for work the system does on its own (`null`) |
| `model`, `recordId` | The changed record's model and id (`recordId` defaults to `after.id`, then `before.id`) |
| `changes` | The fields that differ between `before` and `after`, as `{ field: { from, to } }`; leave out `before` for creates and `after` for deletes (missing values are `null`). `id`, `createdAt` and `updatedAt` are skipped and dates are ISO strings |
| `data` | Anything else you pass as `data` |
| `source` | Where it was written: `"PATCH /tickets/:id"` or `"job export-tickets"` |
| `requestId` | The request's id, also in its `X-Request-Id` header and log lines |
| `tenantId` | In [multi-tenant apps](database.md#multi-tenancy), the tenant it happened in: the signed-in user's tenant in routes, the job's tenant in jobs. Pass `tenantId` to name another, or `null` for none |
| `createdAt` | When |

- Secrets never reach the table: changed fields named like `password`, `token`, `secret`, `apiKey`, `*Hash`, `session` or `cookie` are stored as `"[redacted]"` without their values, the same names in `data` are redacted, and values from `createApp({ redact })` and AI provider keys are replaced inside any string.
- Writing is explicit: nothing is recorded unless you call `audit`, so you choose which actions matter. Call it after the change succeeded. It writes with the request's (or job's) `db`, outside any `db.$transaction`; when the entry must be part of a transaction, insert it with the transaction's client: `tx.audit_log.insert({ action, userId: user.id, model: "tickets", recordId, changes: auditChanges(before, after) })`.
- Read it like any table: `db.audit_log.findMany({ where: { model: "tickets", recordId: id }, orderBy: { createdAt: "desc" } })`. In multi-tenant apps, show a customer only their own entries with `where: { tenantId }` (`audit_log` is not a tenant-scoped table, so an admin can read every tenant's entries). Apps that already have an `audit_log` table get the `tenant_id` column from `inferlo db migrate`. Protect routes that show it with a permission such as `"audit.view"`.
- Without `AuditLog` in the models, `audit` raises IL6027, as do an empty action name or an entry that is not an object. `auditChanges(before, after)` is exported to compute the same `changes` yourself.

## Cookie sessions

For browser apps, `sessions()` signs users in with a cookie: signed with HMAC-SHA256, `HttpOnly`, `Secure` and `SameSite=Lax` by default, with no session table and no runtime dependency. Requests that change data must carry a CSRF token, so other sites cannot act for a signed-in browser.

```ts
// src/session.ts
import { sessions } from "@browserlessapi/inferlo";
import { settings } from "./config.ts"; // SESSION_SECRET: t.string().min(32), listed in secrets

export const session = sessions({
  secret: settings.SESSION_SECRET,
  async user({ userId }, { db }) {
    const user = await db.users.find(userId);
    return user ? { id: user.id, email: user.email, name: user.name, roles: [user.role] } : null;
  },
});

// src/app.ts
createApp({ auth: session, ... });
```

Sign in and out in routes:

```ts
import { route, t, verifyPassword } from "@browserlessapi/inferlo";
import { session } from "../session.ts";

export const login = route
  .post("/login", { auth: "public", body: t.object({ email: t.string(), password: t.string() }), rateLimit: { max: 10, per: "minute", by: "ip" } })
  .handle(async (ctx) => {
    const user = await ctx.db.users.findOne({ email: ctx.body.email });
    if (!user?.passwordHash || !(await verifyPassword(ctx.body.password, user.passwordHash))) {
      return Response.json({ error: { code: "INVALID_LOGIN", message: "Wrong email or password." } }, { status: 401 });
    }
    return session.signIn(ctx, user.id); // { csrfToken }
  });

export const logout = route.post("/logout").handle((ctx) => {
  session.signOut(ctx);
  ctx.status(204);
  return undefined;
});
```

- `session.signIn(ctx, userId)` sets two cookies: `inferlo_session` (the signed session: user id, issue time and expiry; `HttpOnly`) and `inferlo_session_csrf` (the CSRF token, readable by your frontend's JavaScript). It returns `{ csrfToken }`. `session.signOut(ctx)` clears both.
- **CSRF protection.** A POST, PUT, PATCH or DELETE request with a session cookie must send the session's token in an `X-CSRF-Token` header (frontends read it from the `inferlo_session_csrf` cookie or the login answer) or, from an HTML form, a hidden `_csrf` field: `<input type="hidden" name="_csrf" value="...">` with the value of `await session.csrfToken(req)`. Otherwise the request is refused with 403 IL3005 before the handler runs, also on public routes. In a `multipart/form-data` form (file uploads), put the `_csrf` field before the file inputs: it is read from the first 64 KiB of the body. The `_csrf` field is removed from form bodies before validation. GET, HEAD and OPTIONS never change data, so they need no token.
- `user({ userId, issuedAt }, { db })` runs on every request. Return `null` to end a session: for a deleted or disabled user, or to sign a user out everywhere (store a `sessionsValidAfter` time on the user and return `null` when `issuedAt` is older).
- Options: `maxAgeMs` (default 7 days), `cookie: { name, sameSite: "lax" | "strict", secure, domain, path }`. `Secure` is on except for plain `http://localhost` during development. Rotate the secret with `secret: [newSecret, oldSecret]`: new sessions use the first, existing ones stay valid until they expire.
- Cross-origin frontends need `cors: { origin: "https://app.example.com", credentials: true }`; the `X-CSRF-Token` header is allowed in CORS preflights by default.
- Invalid options raise IL6029 at startup. Tampered, expired or foreign cookies are ignored (the request is signed out).

To accept a session cookie or an API key, try the session first:

```ts
const apiKeys = bearer(async (token, { db }) => { /* as below */ });

createApp({
  auth: {
    async resolve(req, ctx) {
      return (await session.resolve(req, ctx)) ?? apiKeys.resolve(req, ctx);
    },
  },
});
```

## Access tokens from an identity provider (JWT)

APIs whose users sign in with an identity provider (Auth0, Okta, Microsoft Entra ID, Google, Keycloak, Clerk, WorkOS, Amazon Cognito, Supabase) receive the provider's access tokens as `Authorization: Bearer <token>`. `jwt()` checks them, with Web Crypto and no runtime dependency:

```ts
import { jwt } from "@browserlessapi/inferlo";

createApp({
  auth: jwt({
    issuer: "https://acme.eu.auth0.com/",          // the iss claim, exactly as the provider writes it
    audience: "https://api.acme.com",              // this API's identifier at the provider (the aud claim)
    user: (claims) => ({ id: claims.sub, email: claims.email as string, roles: (claims.permissions as string[]) ?? [] }),
  }),
});
```

- **What is checked.** The signature, against the issuer's signing keys: found through its OpenID configuration (`<issuer>/.well-known/openid-configuration`, whose `issuer` must match) or given as `jwksUrl`. Then `iss` equals `issuer`, `aud` contains `audience` (a list accepts any of them), `exp` is required and not past, `nbf` and `iat` are not in the future, and `sub` is set, each with 60 seconds of clock tolerance (`clockToleranceSeconds`, at most 300). Any token that fails a check signs nobody in: private routes answer 401 IL3001 and public routes see no user. The reason is never sent to the client.
- **Algorithms.** RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512 and EdDSA (Ed25519) by default; `algorithms: ["RS256"]` narrows the list. The key must match the algorithm in the token (an RSA key never checks an HS256 token), `none` is never accepted, and tokens with a `crit` header are refused. Providers that sign with a shared secret (Supabase's legacy secret, some gateways) pass `secret` (at least 32 characters, from `config({ secrets })`) and get HS256 (`algorithms: ["HS256", "HS512"]` for more).
- **Keys.** Fetched on the first request, kept for 10 minutes (`cacheMs`), and fetched again when a token names a key id the set does not have (the provider rotated its keys), at most every 30 seconds, so random key ids cannot flood the provider. Key URLs must be https (plain http only on localhost). When the keys cannot be loaded and none are cached, requests that send a token answer 503 IL3008 (the provider or the network is down, the token may be fine); cached keys keep working while the provider is unreachable.
- **The user.** `user(claims, { db, req })` returns the app's user, or `null` to refuse the token (a blocked account, a missing scope). Without it, the user is `{ id: sub, email, name, roles }` with `roles` from a `roles` claim. Roles and permissions are in different claims per provider: Auth0 `permissions` (with RBAC on), Keycloak `realm_access.roles`, Entra ID `roles`, Okta `groups`; map them in `user`. Load your own user record there when you keep one: `user: async (claims, { db }) => db.users.findOne({ externalId: claims.sub })`.
- For tenant-scoped models, return `tenantId` from an organization claim (Auth0 `org_id`, Clerk `org_id`, WorkOS `org_id`) or pass `tenant`.
- To accept tokens and your own API keys, try the token first: `resolve: async (req, ctx) => (await tokens.resolve(req, ctx)) ?? apiKeys.resolve(req, ctx)` (see the end of [Cookie sessions](#cookie-sessions)).
- Invalid options raise IL6042 at startup: the audience is required, so tokens the provider issued for your other APIs are refused.

## Better Auth

An app that signs users in with [Better Auth](https://www.better-auth.com) (email and password, OAuth providers, two-factor, organizations, passkeys) uses its sessions as Inferlo's auth with `betterAuthSession(auth)` from `@browserlessapi/inferlo/better-auth`. Better Auth keeps its own tables and endpoints; Inferlo routes get the signed-in user:

```ts
// src/auth.ts
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { betterAuthSession } from "@browserlessapi/inferlo/better-auth";
import { pool } from "./db.ts";
import { settings } from "./config.ts"; // BETTER_AUTH_SECRET: t.string().min(32), listed in secrets

export const auth = betterAuth({
  database: pool,                       // the pg pool Inferlo uses too: postgres({ pool })
  secret: settings.BETTER_AUTH_SECRET,
  baseURL: settings.APP_URL,            // https://app.example.com
  emailAndPassword: { enabled: true },
  plugins: [admin()],                   // optional: user.role becomes the user's roles
});

export const session = betterAuthSession(auth, {
  user: ({ user }) => ({ id: user.id, email: user.email, name: user.name, roles: user.role ? user.role.split(",") : [] }),
});

// src/app.ts
createApp({ models, db: postgres({ pool }), routes, auth: session, middleware: [session.middleware] });
```

- `session.middleware` answers Better Auth's own endpoints (sign-up, sign-in, sign-out, OAuth callbacks, `get-session`) under its `basePath`, `/api/auth` by default, with `auth.handler`. Every other request goes on to the app. Inferlo's secure headers and request ids apply to Better Auth's answers too.
- `user({ user, session }, { db, req })` turns Better Auth's user and session into the app's user, or returns `null` to refuse the session (a blocked account). Without it, the user is `{ id, email, name, roles }` with `roles` from the admin plugin's comma-separated `user.role`. Apps that register their own user type pass `user`. For tenant-scoped models with Better Auth's organization plugin, return `tenantId: session.activeOrganizationId` (or pass `tenant`).
- **Cross-site protection.** Better Auth's cookie is `SameSite=Lax`, and Inferlo also refuses a POST, PUT, PATCH or DELETE that carries the session cookie when a browser sends it from another site: 403 IL3007 before the handler runs, also on public routes. Browsers mark every request with `Sec-Fetch-Site` or `Origin`, so the app's own pages pass without a token; clients that are not browsers (servers, CLIs, tests) send neither and pass. Pages on other origins of yours (an admin site) need `trustedOrigins: ["https://admin.example.com"]`; by default, Better Auth's own `trustedOrigins` list and the origin of its `baseURL` are trusted. Requests with an `Authorization` header (Better Auth's `bearer()` plugin, for mobile apps and scripts) are not checked, because browsers never add that header on their own.
- **Tables.** Better Auth's tables (`user`, `session`, `account`, `verification`) come from its own migrations (`npx @better-auth/cli migrate`, or `getMigrations(auth.options)` from `better-auth/db/migration` in code). `inferlo db migrate` never changes tables it did not create, and Better Auth's migrations never touch Inferlo's. Keep Better Auth's user id in Inferlo models as a plain field (`ownerId: t.string().index()`); read Better Auth's tables with `db.$sql('select name from "user" where id = $1', [id])`.
- Better Auth rate-limits its own endpoints in production; Inferlo's `rateLimit` applies to Inferlo routes. Shut down with `await app.close()`, then `await pool.end()`.
- Invalid arguments raise IL6041 at startup. A tested example is in `examples/with-better-auth`, tested with `better-auth` 1.6.0 and the latest Better Auth on the oldest supported and newest PostgreSQL.

## API keys with bearer()

```ts
import { bearer, hashToken, createToken } from "@browserlessapi/inferlo";

createApp({
  auth: bearer(async (token, { db }) => {
    const key = await db.api_keys.findOne({ hash: await hashToken(token) });
    if (!key) return null;
    const user = await db.users.find(key.userId);
    return user && { id: user.id, email: user.email, name: user.name, roles: [user.role] };
  }),
});

// Issuing a key: show the token once, store only the hash.
const token = createToken("live");
await db.api_keys.insert({ userId, hash: await hashToken(token) });
```

`bearer()` reads `Authorization: Bearer <token>` and falls back to an `x-api-key` header.

## Passwords

```ts
import { hashPassword, verifyPassword } from "@browserlessapi/inferlo";

const stored = await hashPassword(password);      // PBKDF2-SHA256, 210,000 iterations
const ok = await verifyPassword(password, stored);
```

These use Web Crypto, so they run on Node, Bun, Deno and edge runtimes.

## The user type

Declare your user type once (see [database](database.md#register-your-models-once)) and `ctx.user` is typed in every handler.

In multi-tenant apps, give the user a `tenantId` (or pass `tenant: (user) => user.orgId` to `bearer`, `sessions` or `auth`): `ctx.db` then filters and stamps tenant-scoped models with it. See [multi-tenancy](database.md#multi-tenancy).
