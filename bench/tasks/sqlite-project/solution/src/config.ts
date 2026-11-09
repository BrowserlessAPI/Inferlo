import { config, t } from "@browserlessapi/inferlo";

// Every environment variable the app reads, validated once at startup (IL7003 lists what is wrong).
// Values come from the environment (inferlo dev reads .env), then from `environments`, then defaults.
// Secrets are redacted when settings are logged or serialised.
export const settings = config({
  schema: t.object({
    // The SQLite database file. Its folder must exist.
    SQLITE_PATH: t.string().default("data/app.db"),
    PORT: t.int().min(1).max(65535).default(3000),
    ANTHROPIC_API_KEY: t.string().default(""),
    OPENAI_API_KEY: t.string().default(""),
    // Set to serve Prometheus metrics at GET /metrics (scrapers send it as a bearer token).
    METRICS_TOKEN: t.string().min(16).optional(),
  }),
  secrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "METRICS_TOKEN"],
});
