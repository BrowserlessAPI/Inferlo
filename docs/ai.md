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

## Use it without createApp

The AI module also works on its own, in any framework (Express, Hono, Fastify, NestJS, Next.js route handlers), a script or a queue worker. Import it from `@browserlessapi/inferlo/ai`, which never loads the router, database or jobs code:

```ts
import { createAI, anthropic, openai, env, t } from "@browserlessapi/inferlo/ai";

export const ai = createAI({
  providers: {
    anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }),
    openai: openai({ apiKey: env("OPENAI_API_KEY") }),
  },
  models: { fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"], embed: "openai:text-embedding-3-small" },
  onUsage: (usage) => console.log(usage),
});

const { object } = await ai.generate({
  model: "fast",
  prompt: "Classify: the export button does nothing",
  output: t.object({ label: t.enum(["bug", "feature", "question"]) }),
  for: userId,
});
```

`createAI` takes the same options as `createApp({ ai })`, and `ai` has the same `generate`, `stream`, `embed` and `aliases` as `ctx.ai` in a route handler. The entry point also exports the providers, `mockProvider` for tests, `t` and `toJSONSchema` for structured output, `tool` for [function tools](#tools-let-the-model-call-your-functions), `env`, `InferloError`, `httpError` and the types (`AI`, `AIConfig`, `Usage`, `Message`, `Provider`, `ToolDef`, ...). Tools made from routes need a route handler (IL5009); function tools work anywhere.

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

## Images (vision)

Pass images with the prompt to any vision model (Anthropic, OpenAI, Gemini, and OpenAI-compatible servers such as Ollama with a vision model):

```ts
const { text } = await ai.generate({
  model: "fast",
  prompt: "What is wrong in this screenshot?",
  images: [{ url: "https://example.com/screenshot.png" }],
  for: user.id,
});

// Base64 data, for example from an upload: no data: prefix, plus the media type.
await ai.generate({ prompt: "Read the receipt total", images: [{ base64: data, mediaType: "image/jpeg" }], output: Receipt });
```

- An image is `{ url }` (`https://`, `http://` or a `data:image/...;base64,` URL) or `{ base64, mediaType }`. Media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- In a conversation, put images on user messages: `messages: [{ role: "user", content: "Here is the receipt", images: [...] }]`.
- Remote URLs are passed to the provider as they are, and the provider downloads them; Inferlo never fetches them. If a provider cannot download a URL, send base64 instead.
- Works with `ai.stream`, `output` and `tools` too. Invalid images raise IL5012 before any model is called.
- In tests, `mockProvider` receives the images on `request.messages[i].images`.

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

## Tools: let the model call your functions

Make a tool from a plain function with `tool(name, { description, input }).handle(fn)` and pass it in `tools`. Function tools work everywhere: with `createAI` from `@browserlessapi/inferlo/ai` in any framework, and with `ctx.ai` in a route handler, next to route tools.

```ts
import { createAI, tool, t, httpError } from "@browserlessapi/inferlo/ai";

export const getWeather = tool("getWeather", {
  description: "Current weather for a city",
  input: t.object({ city: t.string(), unit: t.enum(["c", "f"]).default("c") }),
}).handle(async ({ input, signal }) => {
  const weather = await weatherApi(input.city, input.unit, { signal });
  if (!weather) throw httpError(404, `No weather for ${input.city}.`);
  return weather;
});

const { text, steps } = await ai.generate({ model: "fast", prompt: "Do I need an umbrella in Oslo?", tools: [getWeather] });
```

- **Input is validated.** The model's arguments are checked against `input` (defaults applied) before your function runs. Invalid arguments go back to the model as a failed tool result with status 422 and IL1001, so it can correct itself.
- **Output** is any JSON value, sent to the model as JSON, or a string, sent as it is. `steps[i].toolCalls` has the `output` with status 200.
- **Errors.** Throw `httpError(404, "...")` (or `notFound`, `forbidden`, any `InferloError` with a status below 500) to send a failed tool result to the model. Any other error is not hidden: `ai.generate` rejects with it, after reporting the usage so far.
- **Names** are letters, digits, `_` and `-` (the provider limit), and must be unique in one call. Invalid definitions raise IL5013.
- `signal` is the `ai.generate` call's `signal`, so long tools stop with the call.
- Step limit, usage per step, budgets and fallback work as for route tools below.

## Tools: let the model call your routes

Pass routes as `tools` and the model can call them while it works out its answer. Each tool call runs as an HTTP request to the route **as the current user**: the route's `auth`, roles and schema validation apply exactly as they do for any other client, so a model can never do more than the user could.

```ts
import { route, t } from "@browserlessapi/inferlo";
import { createTicket, getTicket, listTickets } from "./tickets.ts";

export const assistant = route
  .post("/assistant", { body: t.object({ message: t.string().max(4000) }) })
  .handle(async ({ ai, body, user }) => {
    const { text, steps, usage } = await ai.generate({
      model: "smart",
      system: "You help users manage their support tickets.",
      prompt: body.message,
      tools: [createTicket, getTicket, listTickets],
      maxSteps: 5,
      for: user.id,
    });
    return { reply: text, toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.name)), cost: usage.cost };
  });
```

- **Names and arguments** come from the route: the tool name is the route's export name (`createTicket`, or `tool: { name }`), the description is `tool.description`, `description` or `summary`, and the arguments are the route's `params`, `query` and `body` fields in one JSON Schema (the same tool the MCP server shows). Routes do not need `tool: true` to be used here; that option only controls the MCP server.
- **Errors go back to the model.** A 403, 404 or 422 from the route (or an unknown tool name) is sent to the model as a failed tool result, so it can correct itself.
- **Step limit.** `maxSteps` (default 5) is the most model calls, tool rounds plus the final answer. A model still calling tools at the limit raises IL5010.
- **Usage per step.** `steps` lists every model call with its `text`, `toolCalls` (`name`, `input`, `status`, `output`, `isError`) and `usage`; `usage` has the totals and is reported to `onUsage` once. `allow` is checked again before every model call that follows tool calls, so budgets stop a long run.
- **Fallback.** Once a tool has run, Inferlo does not retry on the next model in the alias (that would run the tools again); the call fails with IL5006.
- **Structured output** works with tools: pass `output` and the final answer is validated as usual.
- Works with Anthropic, OpenAI, Gemini and OpenAI-compatible servers whose models support tool calling. Route tools only work through `ctx.ai` inside a route handler (IL5009), and must be routes registered in `createApp` (IL5011); function tools work anywhere. Streaming with tools is not supported yet.

In tests, a `mockProvider` can return tool calls:

```ts
mockProvider({
  respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Created it." : { toolCalls: [{ name: "createTicket", input: { title: "Printer on fire" } }] }),
});
```

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

## Tracing

With `createApp({ tracing: { api: otel } })` (or `createAI({ ..., tracing: { api: otel } })` on its own), every call gets an OpenTelemetry span with the provider, the model that answered, tokens and cost; prompts and answers are never recorded. See [Observability, "AI calls"](observability.md#ai-calls).

## Testing

```ts
import { mockProvider } from "@browserlessapi/inferlo";

ai: { providers: { mock: mockProvider({ respond: () => '{"priority":"urgent","summary":"Down"}' }) }, models: { fast: "mock:test" } }
```
