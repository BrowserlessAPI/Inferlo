# AI

Inferlo's AI module gives every route one API for every model provider, with aliases, automatic fallback, typed structured output, streaming, embeddings, usage tracking and budgets.

## Configure

```ts
import { createApp, env, anthropic, openai, gemini, ollama, openaiCompatible } from "@browserlessapi/inferlo";

createApp({
  ai: {
    providers: {
      anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }),
      openai: openai({ apiKey: env("OPENAI_API_KEY") }),
      local: ollama(),
      deepseek: openaiCompatible({ name: "deepseek", baseURL: "https://api.deepseek.com/v1", apiKey: env("DEEPSEEK_API_KEY") }),
    },
    // Aliases: routes use "fast" and "smart", never provider model ids.
    // A list is a fallback order: if the first fails with a timeout, 429 or 5xx, the next is tried.
    models: {
      fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"],
      smart: ["anthropic:claude-sonnet-4-5", "openai:gpt-5"],
      embed: "openai:text-embedding-3-small",
    },
    // Optional: USD per million tokens, for cost tracking. Inferlo ships no prices because they change.
    pricing: { "anthropic:claude-haiku-4-5": { input: 1, output: 5 } },
    onUsage: (usage) => console.log(usage),
    allow: async ({ for: userId }) => (await credits(userId)) > 0,
  },
});
```

`openaiCompatible()` works with any Chat Completions server: OpenAI, DeepSeek, Qwen (DashScope), Groq, Together, OpenRouter, vLLM, LM Studio and others.

## Generate text

```ts
const { text, usage } = await ai.generate({
  model: "fast",
  system: "You are a support assistant.",
  prompt: "Reply to: my order is late",
  for: user.id,
});
```

## Structured output

Pass a schema and get typed, validated data back:

```ts
const Triage = t.object({
  priority: t.enum(["low", "normal", "urgent"]),
  summary: t.string().max(300).describe("One sentence for the agent"),
});

const { object } = await ai.generate({ model: "fast", prompt: ticket.body, output: Triage });
object.priority; // "low" | "normal" | "urgent"
```

Inferlo sends the JSON Schema to the model, extracts the JSON (tolerating code fences), validates it, and if it does not match, asks the model once to fix it, quoting the exact problems. If it still fails you get IL5002. Model fields can be reused directly: `priority: Ticket.fields.priority`.

## Streaming

```ts
export const chat = route
  .post("/chat", { body: t.object({ message: t.string().max(4000) }) })
  .handle(({ body, ai, user }) => ai.stream({ model: "fast", prompt: body.message, for: user.id }).toResponse());
```

`toResponse()` sends server-sent events: `text` events with JSON-encoded chunks, then a `done` event with usage. You can also iterate: `for await (const chunk of ai.stream(...))`, or `await stream.text()`.

## Embeddings

```ts
const { embeddings } = await ai.embed({ input: ["first text", "second text"] });   // uses the "embed" alias
cosineSimilarity(embeddings[0], embeddings[1]);
```

## Usage and budgets

Every call reports a `Usage` record (`requested`, `model` that answered, `inputTokens`, `outputTokens`, `cost`, `for`, `kind`, `durationMs`) to `onUsage`. Store it to bill customers. When `for` is set, `allow` is called first; returning false raises IL5004 (HTTP 402).

## Testing

```ts
import { mockProvider } from "@browserlessapi/inferlo";

ai: { providers: { mock: mockProvider({ respond: () => '{"priority":"urgent","summary":"Down"}' }) }, models: { fast: "mock:test" } }
```
