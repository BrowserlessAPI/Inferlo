import { anthropic, bearer, createApp, env, hashToken, memory, openai } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import * as jobs from "./jobs.ts";
import { models } from "./models.ts";
import * as health from "./routes/health.ts";
import * as notes from "./routes/notes.ts";

const databaseUrl = env("DATABASE_URL", { optional: true });

export const app = createApp({
  name: "{{name}}",
  version: "0.1.0",
  models,
  // inferlo:routes
  routes: [health, notes],
  jobs: [jobs],
  db: databaseUrl ? postgres({ url: databaseUrl }) : memory(),
  // Jobs are kept in the database (table inferlo_jobs) and shared by every instance.
  jobQueue: { store: databaseUrl ? "database" : "memory" },

  // Requests send "Authorization: Bearer <api key>". Keys are stored as SHA-256 hashes.
  auth: bearer(async (token, { db }) => {
    const key = await db.api_keys.findOne({ hash: await hashToken(token) });
    if (!key) return null;
    const user = await db.users.find(key.userId);
    return user ? { id: user.id, email: user.email, name: user.name, roles: [user.role] } : null;
  }),

  ai: {
    providers: {
      anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }),
      openai: openai({ apiKey: env("OPENAI_API_KEY", { default: "" }) }),
    },
    // Aliases keep model ids in one place. A list means: try in order.
    models: {
      fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"],
      smart: ["anthropic:claude-sonnet-4-5", "openai:gpt-5"],
    },
  },
});

export default app;
