# Security

Inferlo is secure by default: what you do not turn on stays closed. This page lists the defaults and how to change them.

## Defaults

- **Routes are private.** Every route needs a signed-in user unless it says `auth: "public"`; `auth: "admin"` also checks the role (see [auth](auth.md)). An app with private routes and no `auth` does not start (IL3003).
- **Input is validated.** `body`, `query` and `params` are checked against their `t.*` schemas before the handler runs (IL1001), and unknown fields are removed from bodies.
- **Database values are parameterised.** `db.<table>` methods never build SQL from strings, and every insert and update is validated against the model.
- **Request bodies are limited** to 1 MiB (`createApp({ maxBodySize })`, IL2004).
- **Requests have a time limit** of 60 seconds (`createApp({ requestTimeoutMs })`, per route `timeoutMs`, IL2007), so slow clients and stuck handlers do not hold the server (below).
- **Errors do not leak.** Unexpected errors answer `500` with IL9000 and `"Internal server error"`; the real error is logged. Readiness checks show `"Check failed."`.
- **Secrets stay out of logs.** Authorization and cookie headers, tokens, API keys, passwords in URLs, the AI provider keys and your `config({ secrets })` are replaced with `"[redacted]"` in everything the app logs (below).
- **Cookie sessions resist CSRF.** `sessions()` cookies are signed, `HttpOnly`, `Secure` and `SameSite=Lax`, and requests that change data with a session cookie must send the session's CSRF token (IL3005); see [Cookie sessions](auth.md#cookie-sessions).
- **Single sign-on is checked end to end.** `oidc()` uses the authorization code flow with PKCE, a one-time state and nonce, and checks the ID token's signature, issuer, audience and expiry before it starts a session; `returnTo` can only point at the app. See [Single sign-on](auth.md#single-sign-on-with-openid-connect).
- **Access tokens are fully checked.** `jwt({ issuer, audience })` requires the audience, checks the signature with the issuer's keys and the expiry, and never accepts `none` or an algorithm that does not match the key; see [Access tokens](auth.md#access-tokens-from-an-identity-provider-jwt).
- **Security headers** are sent on every response (below).
- **Rate limits** are one option away: `rateLimit: { max, per, by }` on a route (see [routes](routes.md)).
- **WebSockets only accept their own origin.** A `route.ws` socket may only be opened from the app's own origin or one listed in `cors.origin` (IL3006), because browsers send cookies with WebSocket upgrades from any page; each message is validated and limited like a request (see [WebSockets](websockets.md)).

## Security headers

Every response gets these headers unless it sets them itself:

| Header | Default | What it does |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` | Pages load scripts, styles and images only from your own origin, and cannot be framed |
| `Cross-Origin-Opener-Policy` | `same-origin` | Other sites' windows cannot keep a reference to yours |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites cannot embed your responses with `<img>` or `<script>` (CORS requests still work with `cors`) |
| `Referrer-Policy` | `no-referrer` | URLs with tokens or ids are not sent to other sites |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Browsers use HTTPS for a year. Only sent over HTTPS (with `trustProxy: true`, also when `X-Forwarded-Proto` is `https`) |
| `X-Content-Type-Options` | `nosniff` | Browsers do not guess content types |
| `X-Frame-Options` | `DENY` | No framing, for older browsers |

They are added to every response: routes, errors, 404s, CORS preflights, health endpoints, OpenAPI, MCP, and responses returned by middleware. A header your handler or middleware sets wins, so a route that serves an HTML page can send its own `Content-Security-Policy`.

Change a header by name (any case), leave one out with `false`, or add your own:

```ts
export const app = createApp({
  // ...
  secureHeaders: {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://cdn.example.com",
    "X-Frame-Options": "SAMEORIGIN",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Permissions-Policy": "camera=(), microphone=()",
    "Cross-Origin-Resource-Policy": false,
  },
});
```

`secureHeaders: false` sends none of them, for example when a proxy in front of the app already adds them. Invalid values (not a string or `false`, line breaks, an invalid header name) raise IL6016. `inferlo describe --json` lists the headers that are sent under `secureHeaders`.

## Request timeouts

Every route has 60 seconds to read its body and run its handler. After that it answers `503` with IL2007 (`"The request took longer than 60000 ms."`), and the request's `ctx.signal` is aborted:

- model calls through `ctx.ai` (`generate`, `stream`, `embed`, including tool rounds) are cancelled, so a stuck provider call stops costing money;
- new `ctx.db` queries fail with IL2007 instead of running (a query already running finishes; put writes that belong together in `db.$transaction`, which then rolls back);
- reading a slow request body stops.

JavaScript cannot stop a running function, so the handler itself keeps going until its next `await` on something that uses the signal; its result is dropped. Pass `ctx.signal` to your own slow work:

```ts
export const importFeed = route
  .post("/feeds/import", { body: Feed, timeoutMs: 120_000 })   // this route may take 2 minutes
  .handle(async ({ body, signal }) => {
    const res = await fetch(body.url, { signal });
    // ...
  });
```

Change the default with `createApp({ requestTimeoutMs: 30_000 })`, give a route its own limit with `timeoutMs`, and turn the limit off with `false` (app-wide or per route), for example for a route that you know streams for a long time. The limit ends when the handler returns: a streamed response (`ai.stream(...).toResponse()`) can keep streaming after it. `ctx.signal` is also aborted when the client disconnects, which cancels `ctx.ai` calls, but not `ctx.db` queries, so a disconnect never leaves half-written data. Invalid values raise IL6017 at startup. `inferlo describe --json` shows `requestTimeoutMs` and each route's own `timeoutMs`.

Tool calls (`ai.generate({ tools })`) and MCP calls run each route with its own limit.

## Secrets in logs

Everything an Inferlo app logs (failed requests, failed jobs, readiness checks, shutdown) goes through a redactor before it reaches your `logger` or the console, and so do error messages shown with `exposeErrors`. It replaces with `"[redacted]"`:

- header values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and `Api-Key`, also inside error text and JSON (`Authorization: Bearer [redacted]`), and `Bearer` or `Basic` credentials anywhere;
- passwords in URLs and connection strings (`postgres://app:[redacted]@db:5432/app`) and secrets in query strings (`?key=`, `token=`, `access_token=`, `api_key=`, `password=`, `signature=`);
- common API key formats (`sk-...` for OpenAI and Anthropic, `AIza...` for Google, GitHub tokens);
- the API keys of the app's AI providers (`anthropic({ apiKey })`, `openai`, `gemini`, `openaiCompatible`), even when a provider echoes one back in an error;
- the values you pass to `createApp({ redact })`: your `config()` result (the values of its `secrets`) and any other strings;
- in logged objects, values under keys such as `authorization`, `cookie`, `password`, `secret`, `token`, `apiKey`, `accessToken`, `clientSecret` and `privateKey`.

```ts
import { settings } from "./config.ts";

export const app = createApp({
  // ...
  redact: [settings, process.env.LEGACY_WEBHOOK_SECRET],
});
```

Logged errors stay errors (same class, `code`, `status` and `cause`, with redacted `message` and `stack`), so a custom `logger` can still read them; the originals are not changed. `undefined` and empty values in `redact` are skipped (an unset optional variable); anything that is not a string or a `config()` result raises IL6018. Values shorter than 6 characters are not replaced, because they would hide ordinary text. The standalone `createAI` hides its providers' keys in what it logs too.

## Shutting down

`app.close()` stops taking requests without cutting off the ones in progress; see [graceful shutdown](deploy.md#graceful-shutdown).
