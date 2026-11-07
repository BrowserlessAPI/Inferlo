import { anthropic, createApp, jwt, memory, openai } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import { settings } from "./config.ts";
import { models } from "./models.ts";
import * as notes from "./routes/notes.ts";

export const app = createApp({
  name: "{{name}}",
  version: "0.1.0",
  models,
  // inferlo:routes
  routes: [notes],
  // GET /health (liveness) and GET /ready (readiness: database and AI configuration).
  health: true,
  // Config secrets never appear in logs (provider keys, tokens and passwords in URLs are hidden too).
  redact: [settings],
  // One log line per request with its id (also in the X-Request-Id header), status and duration.
  // Use format: "json" for one JSON object per line when a log collector reads the output.
  logging: { requests: true },
  // Prometheus metrics at GET /metrics (requests, jobs, AI calls, tokens and cost) when METRICS_TOKEN is set.
  metrics: settings.METRICS_TOKEN ? { token: settings.METRICS_TOKEN } : false,
  db: settings.DATABASE_URL ? postgres({ url: settings.DATABASE_URL }) : memory(),

  // Requests send "Authorization: Bearer <access token>" from the identity provider.
  auth: jwt({
    issuer: settings.AUTH_ISSUER,
    audience: "https://api.example.com",
    user: (claims) => ({
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : "",
      name: typeof claims.name === "string" ? claims.name : "",
      roles: Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [],
    }),
  }),

  ai: {
    providers: {
      anthropic: anthropic({ apiKey: settings.ANTHROPIC_API_KEY }),
      openai: openai({ apiKey: settings.OPENAI_API_KEY }),
    },
    // Aliases keep model ids in one place. A list means: try in order.
    models: {
      fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"],
      smart: ["anthropic:claude-sonnet-4-5", "openai:gpt-5"],
    },
  },
});

export default app;
