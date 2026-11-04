# Security

Inferlo is secure by default: what you do not turn on stays closed. This page lists the defaults and how to change them.

## Defaults

- **Routes are private.** Every route needs a signed-in user unless it says `auth: "public"`; `auth: "admin"` also checks the role (see [auth](auth.md)). An app with private routes and no `auth` does not start (IL3003).
- **Input is validated.** `body`, `query` and `params` are checked against their `t.*` schemas before the handler runs (IL1001), and unknown fields are removed from bodies.
- **Database values are parameterised.** `db.<table>` methods never build SQL from strings, and every insert and update is validated against the model.
- **Request bodies are limited** to 1 MiB (`createApp({ maxBodySize })`, IL2004).
- **Errors do not leak.** Unexpected errors answer `500` with IL9000 and `"Internal server error"`; the real error is logged. Readiness checks show `"Check failed."`.
- **Secrets stay out of logs.** `config({ secrets })` values print as `"[redacted]"` (see [configuration](config.md)).
- **Security headers** are sent on every response (below).
- **Rate limits** are one option away: `rateLimit: { max, per, by }` on a route (see [routes](routes.md)).

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

## Shutting down

`app.close()` stops taking requests without cutting off the ones in progress; see [graceful shutdown](deploy.md#graceful-shutdown).
