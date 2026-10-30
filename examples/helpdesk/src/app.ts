import { anthropic, bearer, createApp, env, memory, openai } from "../../../src/index.ts";
import { models } from "./models.ts";
import * as tickets from "./routes/tickets.ts";

const users = new Map([
  ["member-token", { id: "00000000-0000-4000-8000-000000000001", name: "Asha", roles: [] }],
  ["agent-token", { id: "00000000-0000-4000-8000-000000000002", name: "Ravi", roles: ["agent"] }],
]);

export const app = createApp({
  name: "helpdesk",
  version: "1.0.0",
  models,
  routes: [tickets],
  db: memory(),
  auth: bearer((token) => users.get(token)),
  ai: {
    providers: {
      anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }),
      openai: openai({ apiKey: env("OPENAI_API_KEY", { default: "" }) }),
    },
    models: { fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"] },
  },
});

export default app;
