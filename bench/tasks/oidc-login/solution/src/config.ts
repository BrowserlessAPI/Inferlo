import { config, t } from "@browserlessapi/inferlo";

// Every environment variable the app reads, validated once at startup (IL7003 lists what is wrong).
// Values come from the environment (inferlo dev reads .env), then from `environments`, then defaults.
// Secrets are redacted when settings are logged or serialised.
export const settings = config({
  schema: t.object({
    // Leave empty to use the in-memory database (data resets on restart).
    DATABASE_URL: t.string().optional(),
    PORT: t.int().min(1).max(65535).default(3000),
    ANTHROPIC_API_KEY: t.string().default(""),
    OPENAI_API_KEY: t.string().default(""),
    // Set to serve Prometheus metrics at GET /metrics (scrapers send it as a bearer token).
    METRICS_TOKEN: t.string().min(16).optional(),
    // Signs session cookies: at least 32 random characters (openssl rand -base64 32).
    SESSION_SECRET: t.string().min(32),
    // The company's OpenID Connect provider (Okta, Entra ID, Google Workspace, Keycloak).
    OIDC_ISSUER: t.string(),
    OIDC_CLIENT_ID: t.string(),
    OIDC_CLIENT_SECRET: t.string(),
  }),
  secrets: ["DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "METRICS_TOKEN", "SESSION_SECRET", "OIDC_CLIENT_SECRET"],
});
