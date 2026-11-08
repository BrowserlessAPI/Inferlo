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

### Any Vercel AI SDK provider

`aiSdk(provider)` turns any [Vercel AI SDK](https://ai-sdk.dev) provider into an Inferlo provider, so the providers Inferlo has no adapter of its own for (Mistral, Amazon Bedrock, Azure OpenAI, Google Vertex AI, Groq, xAI, Cohere, the AI Gateway and the others) work with aliases, fallback, structured output, tools, streaming, embeddings, usage tracking, budgets and tracing:

```ts
import { aiSdk, createApp } from "@browserlessapi/inferlo";
import { createMistral } from "@ai-sdk/mistral";
import { bedrock } from "@ai-sdk/amazon-bedrock";

createApp({
  ai: {
    providers: {
      mistral: aiSdk(createMistral({ apiKey: settings.MISTRAL_API_KEY })),
      bedrock: aiSdk(bedrock),
    },
    models: {
      fast: ["mistral:mistral-small-latest", "bedrock:anthropic.claude-haiku-4-5-20251001-v1:0"],
      embed: "mistral:mistral-embed",
    },
  },
});
```

- Pass the **provider** (what `createMistral()` returns, or the default `mistral` instance), not a model: the part after the colon in `"mistral:mistral-small-latest"` is the model id Inferlo asks the provider for, as with every other provider. To use models you built yourself (for example with `wrapLanguageModel` middleware), group them with `customProvider({ languageModels: { ... }, embeddingModels: { ... } })` from `ai` and pass that.
- Works with providers made for `ai` 5, 6 and 7 (`@ai-sdk/*` 2.0 and later: language model specifications v2, v3 and v4). Inferlo does not depend on the AI SDK; install the provider packages you use. An older provider, or anything that is not a provider, raises IL5029.
- Errors of the AI SDK (`APICallError`) become IL5006 with the HTTP status, so 429, 5xx and network errors move on to the next model of an alias like any other provider. Embeddings are sent in batches of the model's `maxEmbeddingsPerCall`.
- The provider name in errors and traces is the AI SDK's own (`mistral`); `aiSdk(provider, { name: "eu-mistral" })` sets another.
- `ai.stream` streams text; tool calls are available with `ai.generate`, as with every provider.

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

### Zod, Valibot and ArkType schemas

Apps that already describe their data with Zod, Valibot or ArkType (often when `@browserlessapi/inferlo/ai` runs inside Express, NestJS, Fastify or Next.js) can pass those schemas as `output`, and as a [tool's](#tools-let-the-model-call-your-functions) `input`. Any [Standard Schema](https://standardschema.dev) that also implements Standard JSON Schema works:

```ts
import { createAI } from "@browserlessapi/inferlo/ai";
import { z } from "zod";

const Triage = z.object({
  priority: z.enum(["low", "normal", "urgent"]),
  summary: z.string().max(300).describe("One sentence for the agent"),
});

const { object } = await ai.generate({ model: "fast", prompt: ticket.body, output: Triage });
object.priority; // "low" | "normal" | "urgent", typed by Zod
```

| Library | Pass | Needs |
|---|---|---|
| Zod | `z.object({ ... })` | zod 4.2 or later |
| ArkType | `type({ ... })` | arktype 2.1.28 or later |
| Valibot | `toStandardJsonSchema(v.object({ ... }))` from `@valibot/to-json-schema` | `@valibot/to-json-schema` 1.5 or later (a plain Valibot schema has no JSON Schema) |

- The model is shown the library's own JSON Schema (`"~standard".jsonSchema.input`), and its answer is validated by the library, so transforms and defaults apply and `object` has the library's output type. Mismatches are sent back to the model with the library's messages, as with `t.*` schemas.
- The schema must be expressible as JSON Schema: no `z.date()`, functions or input-side transforms. A schema that is not one, or that has no JSON Schema, raises IL5032 before any model is called.
- Inside an Inferlo app, keep using `t.*` schemas for routes, models and jobs; Standard Schema support is for the AI module only, so existing schemas can be reused there.

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

- **Input is validated.** The model's arguments are checked against `input` (defaults applied) before your function runs. `input` is a `t.object({ ... })`, or an object schema from Zod, ArkType or Valibot (see [Zod, Valibot and ArkType schemas](#zod-valibot-and-arktype-schemas)): `tool("fileTicket", { description, input: z.object({ title: z.string() }) })`. Invalid arguments go back to the model as a failed tool result with status 422 and IL1001, so it can correct itself.
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

### Chat UIs with the Vercel AI SDK (useChat)

`toResponse({ format: "ai-sdk" })` answers with the AI SDK UI message stream protocol, so `useChat` from `@ai-sdk/react` (or `@ai-sdk/vue`, `@ai-sdk/svelte`) talks to an Inferlo route directly. `uiChatBody` validates the body `useChat` sends, and `fromUIMessages` turns its messages into model messages:

```ts
import { fromUIMessages, route, uiChatBody } from "@browserlessapi/inferlo";

export const chat = route
  .post("/api/chat", { body: uiChatBody, rateLimit: { max: 30, per: "minute" } })
  .handle(({ body, ai, user }) =>
    ai.stream({ model: "fast", messages: fromUIMessages(body.messages), for: user.id }).toResponse({ format: "ai-sdk" }),
  );
```

```tsx
// In the browser (React). useChat posts to /api/chat by default.
import { useChat } from "@ai-sdk/react";

const { messages, sendMessage, status } = useChat();
```

- **Body.** `uiChatBody` accepts what `useChat` sends (`{ id, messages, trigger, ... }`) and keeps each message's `role` (`system`, `user` or `assistant`) and its parts' `type` and `text`; ids, metadata and other fields are dropped. It allows 1 to 500 messages, 100 parts per message and 100,000 characters per text part. Combine it with a route's `rateLimit` and the AI module's budgets.
- **Messages.** `fromUIMessages(messages)` joins the text parts of each message and leaves out other parts (files, reasoning, tool calls, data parts); messages without text are dropped. Add your own system message in front: `messages: [{ role: "system", content: "..." }, ...fromUIMessages(body.messages)]`. A client can send any role, including `system`, so filter with `.filter((m) => m.role !== "system")` when callers must not change your instructions.
- **Stream.** The answer is one text part: `start`, `text-start`, `text-delta` chunks, `text-end`, `finish`, then `[DONE]`, with the `x-vercel-ai-ui-message-stream: v1` header. If the model call fails, the stream ends with an `error` chunk that carries only the error code (`The model call failed (IL5006).`); details stay in your logs. Usage is recorded on the server (`onUsage`, budgets), not sent to the browser.
- **Auth.** The route is private by default: `useChat({ transport: new DefaultChatTransport({ api: "/api/chat", headers: { authorization: "Bearer " + token } }) })` sends a token, and cookie sessions work without extra options.
- **Versions.** Tested with the `ai` package 5.0.0 (the first release with this protocol) and the latest release, through its `DefaultChatTransport`, the transport `useChat` uses. Nothing from the `ai` package is loaded by Inferlo.
- An unknown `format` raises IL5027.

### Inferlo models in AI SDK Core (generateText, streamText, agents)

Code written with the AI SDK's own functions (`generateText`, `streamText`, `generateObject`, `ToolLoopAgent`) runs on Inferlo's AI with `toAISdkModel`, and Inferlo tools become AI SDK tools with `toAISdkTools`:

```ts
import { generateText, stepCountIs } from "ai";
import { route, t, toAISdkModel, toAISdkTools } from "@browserlessapi/inferlo";

export const ask = route
  .post("/ask", { body: t.object({ question: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    const { text } = await generateText({
      model: toAISdkModel(ai, { model: "fast", for: user.id }),
      tools: toAISdkTools([getWeather, createTicket], { ai }),
      stopWhen: stepCountIs(5),
      prompt: body.question,
    });
    return { answer: text };
  });
```

- **`toAISdkModel(ai, { model, for })`** is a language model in the AI SDK's format (specification v2, which `ai` 5, 6 and 7 accept). Every call goes through Inferlo's AI client: the alias and its fallback models, budgets (`allow`), usage tracking (`onUsage`, with `for`), tracing and every configured provider. `system`, `temperature` and `maxOutputTokens` are used and the result's `usage` counts the tokens; other settings (`topP`, `seed`, ...) are not passed on and come back as warnings. Structured output (`generateObject`, `Output.object`) is asked for in the instructions and the JSON is taken out of the answer. `streamText` works; the answer arrives as one text chunk. Images in user messages reach vision models; other files raise IL5035, as do provider tools (such as OpenAI's web search), which only that provider's models run.
- **`toAISdkTools(tools, { ai })`** turns Inferlo function tools (`tool(name, ...).handle(fn)`) into AI SDK tools, keyed by name, with the tool's schema and validation (invalid input goes back to the model as the problem). Routes work too when you pass a request's `ctx.ai`: each call runs as the signed-in user with the route's auth, permissions, validation and rate limits; without `ai`, a route raises IL5009. AI SDK tools made with `tool()` from `ai` work next to them: `tools: { ...toAISdkTools([getWeather]), forecast }`.
- Both are in `@browserlessapi/inferlo` and `@browserlessapi/inferlo/ai` (for apps on other frameworks), and import nothing from the `ai` package. Tested with `ai` 5.0.0, 6 and the latest release. Inside Inferlo routes, `ctx.ai.generate` remains the simplest way to call a model; use these when code already uses the AI SDK.

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
