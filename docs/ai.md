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

### Mistral, Azure OpenAI and Vertex AI

Each has an adapter of its own, with chat, vision, tools, streaming and native structured output (and embeddings on Mistral and Azure OpenAI):

```ts
import { azureOpenAI, createApp, mistral, vertexAI } from "@browserlessapi/inferlo";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { GoogleAuth } from "google-auth-library";

const google = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

createApp({
  ai: {
    providers: {
      mistral: mistral({ apiKey: settings.MISTRAL_API_KEY }),
      // Azure OpenAI v1 API: model ids are your deployment names.
      azure: azureOpenAI({ resource: "contoso-eu", apiKey: settings.AZURE_OPENAI_API_KEY }),
      // Or Microsoft Entra ID (managed identity, workload identity, az login) instead of a key:
      // azure: azureOpenAI({ resource: "contoso-eu", token: getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default") }),
      // Vertex AI: Google Cloud credentials (service account, workload identity, gcloud), no API key.
      vertex: vertexAI({ project: "acme-prod", location: "europe-west4", token: async () => (await google.getAccessToken())! }),
    },
    models: {
      fast: ["azure:gpt-5-mini-prod", "vertex:google/gemini-2.5-flash", "mistral:mistral-small-latest"],
      embed: "mistral:mistral-embed",
    },
  },
});
```

- `mistral({ apiKey, baseURL })` calls `https://api.mistral.ai/v1`; `baseURL` points it at another endpoint with the same API, such as a self-deployed Mistral model.
- `azureOpenAI({ resource })` calls `https://<resource>.openai.azure.com/openai/v1`, Azure's v1 API (no `api-version`); `baseURL` takes the full v1 endpoint instead, such as `https://<name>.services.ai.azure.com/openai/v1` for Azure AI Foundry. Authenticate with `apiKey` (sent as the `api-key` header) or `token`, a function that returns a Microsoft Entra ID bearer token for the scope `https://ai.azure.com/.default`. Inferlo calls `token` before every request and does not keep tokens itself, so use a function that caches them until they expire, such as `getBearerTokenProvider` from `@azure/identity`. A `token` function that fails or returns nothing is IL5006 (status 401, not retried, on every adapter that takes `token`); give the identity the "Cognitive Services OpenAI User" role.
- `vertexAI({ project, location, token })` calls Vertex AI's OpenAI-compatible endpoint, `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/endpoints/openapi` for the default `location: "global"`, or the region's own host (`https://europe-west4-aiplatform.googleapis.com/...`) for a region, which keeps requests and data in that region. Model ids are Vertex AI's publisher ids: `"vertex:google/gemini-2.5-flash"`, and the partner and open models Vertex AI serves on that endpoint. `token` returns an OAuth access token for the scope `https://www.googleapis.com/auth/cloud-platform`; `GoogleAuth` from `google-auth-library` caches and refreshes them. Give the service account the "Vertex AI User" role.
- All three send `response_format` with `json_schema` for `ai.generate({ output })`; `nativeStructuredOutput: false` sends `json_object` instead. Inferlo validates every answer either way.
- Missing or invalid options (no `apiKey`, both or neither of `resource` and `baseURL`, both or neither of `apiKey` and `token`, a `project` or `location` that is not a Google Cloud id) raise IL5041 at startup. API keys are redacted from logs like every provider key.

### Any Vercel AI SDK provider

`aiSdk(provider)` turns any [Vercel AI SDK](https://ai-sdk.dev) provider into an Inferlo provider, so the providers Inferlo has no adapter of its own for (Amazon Bedrock, Groq, xAI, Cohere, the AI Gateway and the others) work with aliases, fallback, structured output, tools, streaming, embeddings, usage tracking, budgets and tracing:

```ts
import { aiSdk, createApp } from "@browserlessapi/inferlo";
import { createXai } from "@ai-sdk/xai";
import { bedrock } from "@ai-sdk/amazon-bedrock";

createApp({
  ai: {
    providers: {
      xai: aiSdk(createXai({ apiKey: settings.XAI_API_KEY })),
      bedrock: aiSdk(bedrock),
    },
    models: {
      fast: ["xai:grok-4-fast", "bedrock:anthropic.claude-haiku-4-5-20251001-v1:0"],
      embed: "bedrock:amazon.titan-embed-text-v2:0",
    },
  },
});
```

- Pass the **provider** (what `createXai()` returns, or the default `xai` instance), not a model: the part after the colon in `"xai:grok-4-fast"` is the model id Inferlo asks the provider for, as with every other provider. To use models you built yourself (for example with `wrapLanguageModel` middleware), group them with `customProvider({ languageModels: { ... }, embeddingModels: { ... } })` from `ai` and pass that.
- Works with providers made for `ai` 5, 6 and 7 (`@ai-sdk/*` 2.0 and later: language model specifications v2, v3 and v4). Inferlo does not depend on the AI SDK; install the provider packages you use. An older provider, or anything that is not a provider, raises IL5029.
- Errors of the AI SDK (`APICallError`) become IL5006 with the HTTP status, so 429, 5xx and network errors move on to the next model of an alias like any other provider. Embeddings are sent in batches of the model's `maxEmbeddingsPerCall`.
- The provider name in errors and traces is the AI SDK's own (`xai`); `aiSdk(provider, { name: "eu-bedrock" })` sets another.
- `ai.stream` streams text, and with `tools` it streams the tool calls too (see [Streaming with tools](#streaming-with-tools)).

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

Providers that can constrain the model to a schema get it in their own field, so the answer matches far more often: OpenAI and Gemini (`response_format` with `json_schema`) and Anthropic (`output_config.format`; limits Anthropic does not accept, such as `min`, `max` and lengths, are moved into the field's description, and Inferlo still checks them and repairs the answer). Turn it off per provider with `nativeStructuredOutput: false` (for example behind a proxy that does not pass the field on); other OpenAI-compatible servers get `response_format: { type: "json_object" }` unless `openaiCompatible({ nativeStructuredOutput: true })`.

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
- Works with Anthropic, OpenAI, Gemini and OpenAI-compatible servers whose models support tool calling. Route tools only work through `ctx.ai` inside a route handler (IL5009), and must be routes registered in `createApp` (IL5011); function tools work anywhere. `ai.stream` takes the same `tools` and `maxSteps` and streams the tool calls as they happen (see [Streaming with tools](#streaming-with-tools)).

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

### Streaming with tools

`ai.stream` takes the same `tools` and `maxSteps` as [`ai.generate`](#tools-let-the-model-call-your-functions). The model's text streams as it is written, Inferlo runs the tools it calls (routes as the signed-in user, function tools anywhere), and the next step's text follows:

```ts
export const chat = route
  .post("/chat", { body: t.object({ message: t.string().max(4000) }) })
  .handle(({ body, ai, user }) =>
    ai.stream({ model: "fast", prompt: body.message, tools: [getWeather, createTicket], for: user.id }).toResponse(),
  );
```

The browser receives, in order:

```
event: text         data: "Let me check. "
event: tool-call    data: {"id":"call_1","name":"getWeather","input":{"city":"Oslo"}}
event: tool-result  data: {"id":"call_1","name":"getWeather","status":200,"isError":false}
event: text         data: "Bring an umbrella."
event: done         data: {"usage":{...}}
```

- **What reaches the browser.** Tool calls (name and arguments) and each result's `status` and `isError` are sent; what the tools returned stays on the server, because it can hold data the user should only see through the model's answer. `toResponse({ toolOutputs: true })` adds `output` to `tool-result` events.
- **On the server**, `stream.events()` yields `{ type: "text", text }`, `{ type: "tool-call", id, name, input }` and `{ type: "tool-result", id, name, input, status, output, isError }` as they happen; iterating the stream itself yields only text. `await stream.steps()` lists every model call with its tool calls and usage, as `steps` does for `ai.generate`. Read a stream one way only.
- **Steps, budgets and fallback** work as in `ai.generate`: `maxSteps` (default 5) limits model calls (IL5010), `allow` is checked before every model call that follows tool calls, usage of every step is reported to `onUsage` once, and Inferlo falls back to the next model of an alias only while nothing was sent and no tool ran (after that, IL5006). An error ends the stream with an `error` event that carries only the code.
- **useChat.** With `toResponse({ format: "ai-sdk" })`, tool calls become tool parts of the message (`tool-input-available`, then `tool-output-available` or `tool-output-error`), and the text after a tool call is a new text part. `output` is `null` unless `toolOutputs: true`; a failed tool sends only its status.
- **WebSockets.** `socket.stream(ai.stream({ tools }))` sends `{ "type": "tool-call", ... }` and `{ "type": "tool-result", ... }` messages (without the output) between the text chunks.
- Anthropic, OpenAI, Gemini, OpenAI-compatible servers, `aiSdk()` providers and `mockProvider` stream tool calls. A custom provider's `stream` yields `{ toolCalls }` once a call's arguments are complete, next to text chunks and `{ usage }`.

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
- **Stream.** The answer is one text part: `start`, `text-start`, `text-delta` chunks, `text-end`, `finish`, then `[DONE]` (with `tools`, tool parts and more text parts, see [Streaming with tools](#streaming-with-tools)), with the `x-vercel-ai-ui-message-stream: v1` header. If the model call fails, the stream ends with an `error` chunk that carries only the error code (`The model call failed (IL5006).`); details stay in your logs. Usage is recorded on the server (`onUsage`, budgets), not sent to the browser.
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

## Prompt files

Keep prompts out of route code, versioned and with typed variables, in `src/prompts/<name>.md`:

```md
---
version: 2
description: Summarize a support ticket
variables:
  title: string
  body: text
---
## System
You summarize support tickets in two sentences.

## Prompt
Summarize the ticket "{{title}}":

{{body}}
```

Run `inferlo prompts` to write `src/prompts/index.ts` (commit it with the `.md` files), then use the prompt in a route:

```ts
import { summarizeTicket } from "../prompts/index.ts";

export const summarize = route
  .post("/tickets/:id/summary", { params: t.object({ id: t.uuid() }), rateLimit: { max: 20, per: "hour" } })
  .handle(async ({ params, ai, db, user }) => {
    const ticket = await db.tickets.get(params.id);
    const { text } = await ai.generate({ model: "fast", ...summarizeTicket.render({ title: ticket.title, body: ticket.body }), for: user.id });
    return { summary: text };
  });
```

- **Variables** are declared in the front matter as `name: type` (`string`, `text`, `number`, `int` or `boolean`) and used as `{{name}}`. `render()` is typed from them and validates the values (IL1001), and returns `{ system, prompt, promptId }` to spread into `ai.generate` or `ai.stream`. A placeholder that is not declared, or a variable that is never used, fails `inferlo prompts` (IL5039).
- **Versions.** `version` is required; raise it whenever the text changes. The usage passed to `onUsage` has `prompt: "summarize-ticket@2"`, and AI spans have the `inferlo.ai.prompt` attribute, so you can compare cost and quality per version.
- **Sections.** Text under `## System` is the system message and text under `## Prompt` the user message; a file without these headings is all prompt. Front matter takes only `version`, `description` and `variables`.
- **CI.** `inferlo prompts --check` fails with IL8009 when `src/prompts/index.ts` does not match the files.
- The generated module calls `prompt({ name, version, system, text, variables })`, which you can also call yourself; `parsePromptFile(source, fileName)` reads a file without the CLI. Nothing reads files at runtime, so prompts work on every runtime, including Workers.

## Embeddings

```ts
const { embeddings } = await ai.embed({ input: ["first text", "second text"] });   // uses the "embed" alias
cosineSimilarity(embeddings[0], embeddings[1]);
```

To search stored embeddings, keep them in a `t.vector()` field and use `db.<table>.search` (see [Vector search](database.md#vector-search)), or `rag()` below, which does the chunking and embedding too.

## Retrieval (RAG)

`rag(table, { ai })` answers questions from your own documents: `add` splits a document into chunks, embeds them in one `ai.embed` call and stores one row per chunk; `search` embeds the question and returns the closest chunks, ready for a prompt.

```ts
// src/models.ts: one row per chunk, with the text and its embedding
export const DocChunk = model("doc_chunks", {
  documentId: t.ref("documents", { onDelete: "cascade" }),
  ownerId: t.ref("users"),
  text: t.text(),
  embedding: t.vector(1536).index(),
});

// src/routes/documents.ts
import { rag, route, t } from "@browserlessapi/inferlo";

export const addDocument = route
  .post("/documents", { body: t.object({ title: t.string().max(200), text: t.text().max(200_000) }), rateLimit: { max: 20, per: "hour" } })
  .handle(async ({ body, ai, db, user, status }) => {
    const doc = await db.documents.insert({ title: body.title, ownerId: user.id });
    await rag(db.doc_chunks, { ai, model: "embed" }).add({ text: body.text, fields: { documentId: doc.id, ownerId: user.id }, for: user.id });
    status(201);
    return doc;
  });

export const ask = route
  .post("/ask", { body: t.object({ question: t.string().min(1).max(2000) }), rateLimit: { max: 30, per: "minute" } })
  .handle(async ({ body, ai, db, user }) => {
    const hits = await rag(db.doc_chunks, { ai, model: "embed" }).search({ query: body.question, where: { ownerId: user.id }, limit: 5, for: user.id });
    const { text } = await ai.generate({
      model: "fast",
      system: `Answer only from these excerpts. Say so when they do not contain the answer.\n\n${hits.map((h) => h.text).join("\n\n---\n\n")}`,
      prompt: body.question,
      for: user.id,
    });
    return { answer: text, sources: [...new Set(hits.map((h) => h.row.documentId))] };
  });
```

- **The table** needs a text field (`text` by default, or `textField`) and one `t.vector()` field (or `vectorField`) whose size matches the embedding model. Other fields (`documentId`, `ownerId`, a tenant) are passed in `fields` and filter searches with `where`, so users only search their own chunks; tenant-scoped tables only search the tenant's rows.
- **Chunks** are at most `chunk.maxChars` characters (default 1000): paragraphs are kept together, then sentences, then words, and chunks are filled while they fit. Each chunk after the first starts with up to `chunk.overlap` characters (default 100) of the end of the previous one, from a word boundary. `chunkText(text, { maxChars, overlap })` returns the chunks without storing anything.
- **add()** validates every row before storing any (IL1001), and stores at most 1000 chunks per call; it returns the rows. Delete a document's chunks with `db.doc_chunks.deleteMany({ documentId })` (or `onDelete: "cascade"` on the reference).
- **search()** returns `{ text, distance, row }` closest first: `limit` (default 5, at most 100), `where`, and `maxDistance` (cosine distance from 0 to 2) to leave out unrelated chunks.
- `model` is the embedding alias (the `"embed"` alias by default, as `ai.embed`); `for` and `signal` work as in `ai.embed`, so budgets and usage tracking apply. Invalid tables and options raise IL5038.
- Works with `memory()` in tests and with Postgres through pgvector.

## Caching answers

Calls that are asked again and again with the same input (an FAQ answer, a product description, a classification of the same text) can reuse the earlier answer instead of calling the model. Caching is opt in per call:

```ts
export const faq = route
  .get("/faq", { query: t.object({ q: t.string().max(500) }) })
  .handle(async ({ ai, query, user }) => {
    const { text, cached } = await ai.generate({ model: "fast", prompt: query.q, cache: { ttlMs: 24 * 3_600_000, tags: ["faq"] }, for: user.id });
    return { answer: text, cached: cached ?? false };
  });

// After the FAQ content changes:
await cache.invalidate("faq");
```

- **Same input, same answer.** The entry's key is a hash of the model or alias (with its fallback models), every message (system, prompt, images), the output schema, `temperature` and `maxTokens`. Change any of them and the call goes to the model. Users who send exactly the same input share the answer; put per-user context in the prompt (or leave out `cache`) when answers must differ per user.
- **Where.** Answers are kept in the app's cache (`createApp({ cache })`: memory, Postgres or Redis), so with a shared store every instance reuses them, and `cache.invalidate(tag)` removes the entries tagged with `cache: { tags }`. `createAI` without an app keeps up to 1000 answers in memory, or pass `createAI({ cache: app.cache })`.
- **What a hit returns.** The same `text` and `object` (validated against the output schema again, so dates come back as `Date`), `cached: true` and empty `steps`. `onUsage` gets the call with `cached: true` and 0 tokens and cost, so dashboards show the savings; `allow` (budgets) is still checked first. Spans have `inferlo.ai.cached`.
- `ttlMs` is required (1 ms to 365 days). Only successful answers are stored. Calls with `tools` cannot be cached, because a cached answer would skip the tool calls (IL5040); `ai.stream` is not cached.

## Usage and budgets

Every call reports a `Usage` record (`requested`, `model` that answered, `inputTokens`, `outputTokens`, `cost`, `for`, `kind`, `durationMs`) to `onUsage`. Store it to bill customers. When `for` is set, `allow` is called first; returning false raises IL5004 (HTTP 402).

## Tracing

With `createApp({ tracing: { api: otel } })` (or `createAI({ ..., tracing: { api: otel } })` on its own), every call gets an OpenTelemetry span with the provider, the model that answered, tokens and cost; prompts and answers are never recorded. See [Observability, "AI calls"](observability.md#ai-calls).

## Testing

```ts
import { mockProvider } from "@browserlessapi/inferlo";

ai: { providers: { mock: mockProvider({ respond: () => '{"priority":"urgent","summary":"Down"}' }) }, models: { fast: "mock:test" } }
```
