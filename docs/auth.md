# Auth

Routes are private by default. Kairo does not force a login system on you: you give `createApp` an `auth.resolve(req)` that returns the user, and Kairo enforces route access.

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

If any route is private and no `auth` is configured, `createApp` throws KR3003 at startup, so a missing auth setup can never silently expose routes.

## Route access

```ts
route.get("/health", { auth: "public" })     // anyone
route.get("/me")                              // any signed-in user (default)
route.delete("/users/:id", { auth: "admin" }) // users whose roles include "admin"
```

## API keys with bearer()

```ts
import { bearer, hashToken, createToken } from "@browserlessapi/kairo";

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
import { hashPassword, verifyPassword } from "@browserlessapi/kairo";

const stored = await hashPassword(password);      // PBKDF2-SHA256, 210,000 iterations
const ok = await verifyPassword(password, stored);
```

These use Web Crypto, so they run on Node, Bun, Deno and edge runtimes.

## The user type

Declare your user type once (see [database](database.md#register-your-models-once)) and `ctx.user` is typed in every handler.
