import { anthropic, bearer, createApp, hashToken, memory, openai } from "@browserlessapi/inferlo";
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
  db: settings.DATABASE_URL ? postgres({ url: settings.DATABASE_URL }) : memory(),

  // Requests send "Authorization: Bearer <api key>". Keys are stored as SHA-256 hashes.
  auth: bearer(async (token, { db }) => {
    const key = await db.api_keys.findOne({ hash: await hashToken(token) });
    if (!key) return null;
    const user = await db.users.find(key.userId);
    return user ? { id: user.id, email: user.email, name: user.name, roles: [user.role] } : null;
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
