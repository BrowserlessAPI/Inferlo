// A Worker (export default app) for test/cloudflare-workers.test.ts, run in workerd through Miniflare.
import { config, createApp, env, openaiCompatible, route, t } from "../../src/index.ts";

// Read once when the Worker starts: string bindings (vars and secrets) are in the environment with nodejs_compat.
const settings = config({
  schema: t.object({ GREETING: t.string(), API_KEY: t.string(), LIMIT: t.int().default(2) }),
  secrets: ["API_KEY"],
});

const greeting = route.get("/greeting", { auth: "public" }).handle(() => ({ greeting: settings.GREETING, fromEnv: env("GREETING"), limit: settings.LIMIT }));

const limited = route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true }));

const later: string[] = [];
const background = route.post("/background", { auth: "public" }).handle(({ waitUntil }) => {
  waitUntil(new Promise<void>((resolve) => setTimeout(() => (later.push("done"), resolve()), 50)));
  return { queued: true };
});
const backgroundDone = route.get("/background", { auth: "public" }).handle(() => ({ later }));

const summary = route.post("/summary", { auth: "public", body: t.object({ text: t.string() }) }).handle(async ({ body, ai }) => {
  const { text, usage } = await ai.generate({ model: "fast", prompt: `Summarize: ${body.text}` });
  return { text, inputTokens: usage.inputTokens };
});

const stream = route.post("/stream", { auth: "public", body: t.object({ text: t.string() }) }).handle(({ body, ai }) => ai.stream({ model: "fast", prompt: body.text }).toResponse());

export default createApp({
  name: "workers-test",
  routes: [{ greeting, limited, background, backgroundDone, summary, stream }],
  ai: {
    providers: { llm: openaiCompatible({ name: "llm", baseURL: "https://llm.example.com/v1", apiKey: settings.API_KEY }) },
    models: { fast: "llm:small" },
  },
  logger: { info() {}, error() {} },
});
