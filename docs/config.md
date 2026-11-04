# Configuration

`config({ schema })` reads every environment variable your app uses, validates them once at startup and gives you typed values. A missing or invalid variable stops the app with one error that lists every problem, instead of failing later in a request.

```ts
// src/config.ts
import { config, t } from "@browserlessapi/inferlo";

export const settings = config({
  schema: t.object({
    DATABASE_URL: t.string(),
    PORT: t.int().min(1).max(65535).default(3000),
    LOG_LEVEL: t.enum(["debug", "info", "warn", "error"]).default("info"),
    DEBUG: t.boolean().default(false),
    ALLOWED_ORIGINS: t.array(t.string()).default(() => []),   // "https://a.io,https://b.io"
    ANTHROPIC_API_KEY: t.string().min(10),
    SENTRY_DSN: t.string().optional(),
  }),
  secrets: ["DATABASE_URL", "ANTHROPIC_API_KEY"],
  environments: {
    test: { DATABASE_URL: "postgres://localhost/app_test", ANTHROPIC_API_KEY: "sk-test-not-used", LOG_LEVEL: "warn" },
  },
});

settings.PORT;      // number
settings.LOG_LEVEL; // "debug" | "info" | "warn" | "error"
```

Use `settings` everywhere instead of reading `process.env` or calling `env()` in routes, so every variable the app needs is in one file.

## Where values come from

For each field, in this order:

1. The environment variable with the field's name. Empty values count as not set. `inferlo dev` and `inferlo worker` read `.env` into the environment first (variables that are already set win), and Bun reads `.env` files itself.
2. `environments[<current environment>]`, for example fixed values for tests.
3. The field's `.default(...)`. Fields without a default must be set, unless they are `.optional()`.

The current environment is `options.environment`, else `INFERLO_ENV`, else `NODE_ENV`, else `"development"`.

Values are converted to the field's type: numbers for `t.int()` and `t.number()`, `true` for `1`, `true`, `yes` and `on` and `false` for `0`, `false`, `no` and `off` with `t.boolean()`, and comma-separated lists for `t.array(...)`. All other `t.*` rules apply (`.min`, `.max`, `.regex`, `t.enum`, `t.email`, `t.url`, `t.uuid`). Fields must not be objects (environment variables are text); use `t.json()` and parse it yourself if you need that.

## Errors

A missing or invalid value throws IL7003 at startup:

```
IL7003  Configuration is invalid (environment "production"). DATABASE_URL: Required. PORT: Expected a number, got string. ANTHROPIC_API_KEY: Invalid value (secret, not shown).
```

`error.details` is `{ environment, issues: [{ key, code, message }] }`. Mistakes in the options themselves (a secret or an `environments` key that is not in the schema, a schema that is not `t.object`) throw IL7004.

## Secrets

Fields listed in `secrets` are never shown: `JSON.stringify(settings)`, `console.log(settings)` and `String(settings)` print `"[redacted]"` instead of their values, and IL7003 does not include them. Reading `settings.DATABASE_URL` in code still gives the real value, so pass it to `postgres({ url })` or a provider, never to a log line. List every API key, password, token and connection URL as a secret.

Pass the settings to `createApp({ redact: [settings] })` (new projects do) and the values of its secrets are also replaced with `"[redacted]"` wherever they turn up in what the app logs, for example inside an error message from another service. See [secrets in logs](security.md#secrets-in-logs).

The returned object is frozen, so code cannot change configuration at runtime.

## Testing

In a test, `setEnv({ PORT: "0", DATABASE_URL: undefined })` overrides variables for `config()` and `env()` (names you leave out are still read from the environment), and `setEnv(undefined)` removes the overrides. Or set `NODE_ENV=test` (Bun's test runner does) and keep test values in `environments.test`.
