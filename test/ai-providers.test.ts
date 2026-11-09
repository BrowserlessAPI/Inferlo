import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { azureOpenAI, createAI, InferloError, mistral, ProviderError, t, tool, vertexAI } from "../src/index.ts";
import { secretsOf } from "../src/redact.ts";
import { azureOpenAI as azureFromEntry, mistral as mistralFromEntry, vertexAI as vertexFromEntry } from "../src/ai/public.ts";

// Mistral and Azure OpenAI adapters: both speak the Chat Completions API, with their own endpoints, authentication
// and structured output. Every request is checked as the provider receives it.

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function recorder(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), headers: Object.fromEntries(new Headers(init!.headers).entries()), body: JSON.parse(String(init!.body)) };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetch };
}

const chat = (content: string) => Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });

function sse(chunks: unknown[]): Response {
  const text = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

describe("mistral()", () => {
  test("generates text on La Plateforme with the API key as a bearer token", async () => {
    const { calls, fetch } = recorder(() => chat("Bonjour"));
    const ai = createAI({ providers: { mistral: mistral({ apiKey: "m-key", fetch }) }, models: { fast: "mistral:mistral-small-latest" } });
    const result = await ai.generate({ model: "fast", system: "Be brief.", prompt: "Hi", maxTokens: 50, temperature: 0.2 });
    assert.equal(result.text, "Bonjour");
    assert.deepEqual(result.usage.inputTokens, 12);
    assert.equal(calls[0]!.url, "https://api.mistral.ai/v1/chat/completions");
    assert.equal(calls[0]!.headers.authorization, "Bearer m-key");
    assert.equal(calls[0]!.body.model, "mistral-small-latest");
    assert.equal(calls[0]!.body.max_tokens, 50);
    assert.equal(calls[0]!.body.temperature, 0.2);
    assert.deepEqual(calls[0]!.body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }]);
  });

  test("structured output sends response_format json_schema, and nativeStructuredOutput: false sends json_object", async () => {
    const Answer = t.object({ city: t.string(), population: t.int().min(0) });
    const { calls, fetch } = recorder(() => chat(JSON.stringify({ city: "Paris", population: 2100000 })));
    const ai = createAI({
      providers: { mistral: mistral({ apiKey: "k", fetch }), plain: mistral({ apiKey: "k", nativeStructuredOutput: false, fetch }) },
      models: { m: "mistral:mistral-large-latest", p: "plain:mistral-large-latest" },
    });
    const { object } = await ai.generate({ model: "m", prompt: "Capital of France?", output: Answer });
    assert.deepEqual(object, { city: "Paris", population: 2100000 });
    assert.equal(calls[0]!.body.response_format.type, "json_schema");
    assert.equal(calls[0]!.body.response_format.json_schema.name, "output");
    assert.deepEqual(calls[0]!.body.response_format.json_schema.schema.required, ["city", "population"]);
    await ai.generate({ model: "p", prompt: "Capital of France?", output: Answer });
    assert.deepEqual(calls[1]!.body.response_format, { type: "json_object" });
  });

  test("streams text, tool calls and the usage from the last chunk, without stream_options", async () => {
    const { calls, fetch } = recorder(() =>
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "abc123XYZ", function: { name: "weather", arguments: '{"city":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Lyon"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
        "[DONE]",
      ]),
    );
    const replies = [
      () => undefined,
      () => sse([{ choices: [{ delta: { content: "Sunny " } }] }, { choices: [{ delta: { content: "in Lyon" } }], usage: { prompt_tokens: 30, completion_tokens: 3 } }, "[DONE]"]),
    ];
    let n = 0;
    const provider = mistral({
      apiKey: "k",
      fetch: async (url, init) => {
        const answer = replies[n++]!();
        return answer ?? fetch(url, init);
      },
    });
    const weather = tool("weather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, sky: "sunny" }));
    const ai = createAI({ providers: { mistral: provider }, models: { fast: "mistral:mistral-small-latest" } });
    const stream = ai.stream({ model: "fast", prompt: "Weather in Lyon?", tools: [weather] });
    let text = "";
    for await (const chunk of stream) text += chunk;
    assert.equal(text, "Sunny in Lyon");
    assert.equal((await stream.usage()).inputTokens, 50);
    const steps = await stream.steps();
    assert.equal(steps[0]!.toolCalls[0]!.name, "weather");
    assert.deepEqual(steps[0]!.toolCalls[0]!.input, { city: "Lyon" });
    assert.equal(calls[0]!.body.stream, true);
    assert.equal(calls[0]!.body.stream_options, undefined, "Mistral's API does not list stream_options");
    assert.equal(calls[0]!.body.tools[0].function.name, "weather");
  });

  test("embeddings in input order", async () => {
    const { calls, fetch } = recorder(() => Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4 } }));
    const ai = createAI({ providers: { mistral: mistral({ apiKey: "k", fetch }) }, models: { embed: "mistral:mistral-embed" } });
    const { embeddings } = await ai.embed({ model: "embed", input: ["a", "b"] });
    assert.deepEqual(embeddings, [[1, 0], [0, 1]]);
    assert.equal(calls[0]!.url, "https://api.mistral.ai/v1/embeddings");
    assert.deepEqual(calls[0]!.body, { model: "mistral-embed", input: ["a", "b"] });
  });

  test("baseURL for another endpoint; the key is held for log redaction; a missing key is IL5041", async () => {
    const { calls, fetch } = recorder(() => new Response("Unauthorized", { status: 401 }));
    const provider = mistral({ apiKey: "m-secret-key", baseURL: "https://mistral.internal.example/v1/", fetch });
    assert.deepEqual(secretsOf(provider), ["m-secret-key"]);
    const ai = createAI({ providers: { mistral: provider }, models: { fast: "mistral:m" } });
    const error = await ai.generate({ model: "fast", prompt: "Hi" }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(calls[0]!.url, "https://mistral.internal.example/v1/chat/completions");
    assert.equal(error.retryable, false);
    for (const apiKey of [undefined, "", "  "]) {
      assert.throws(() => mistral({ apiKey: apiKey as string }), (e: unknown) => e instanceof InferloError && e.code === "IL5041");
    }
  });
});

describe("azureOpenAI()", () => {
  test("calls the v1 API of the resource with the api-key header; model ids are deployment names", async () => {
    const { calls, fetch } = recorder(() => chat("Hello"));
    const ai = createAI({ providers: { azure: azureOpenAI({ resource: "contoso-eu", apiKey: "az-key", fetch }) }, models: { fast: "azure:gpt-5-mini-prod" } });
    assert.equal((await ai.generate({ model: "fast", prompt: "Hi" })).text, "Hello");
    assert.equal(calls[0]!.url, "https://contoso-eu.openai.azure.com/openai/v1/chat/completions");
    assert.equal(calls[0]!.headers["api-key"], "az-key");
    assert.deepEqual(secretsOf(azureOpenAI({ resource: "contoso-eu", apiKey: "az-key" })), ["az-key"]);
    assert.equal(calls[0]!.headers.authorization, undefined);
    assert.equal(calls[0]!.body.model, "gpt-5-mini-prod");
  });

  test("Microsoft Entra ID: the token function runs before each request; baseURL for Foundry endpoints", async () => {
    const { calls, fetch } = recorder(() => chat("{}"));
    const tokens = ["tok-1", "tok-2"];
    const azure = azureOpenAI({ baseURL: "https://contoso.services.ai.azure.com/openai/v1", token: async () => tokens.shift()!, fetch });
    const ai = createAI({ providers: { azure }, models: { fast: "azure:gpt-5-mini" } });
    await ai.generate({ model: "fast", prompt: "a" });
    await ai.generate({ model: "fast", prompt: "b" });
    assert.equal(calls[0]!.url, "https://contoso.services.ai.azure.com/openai/v1/chat/completions");
    assert.equal(calls[0]!.headers.authorization, "Bearer tok-1");
    assert.equal(calls[1]!.headers.authorization, "Bearer tok-2");
    assert.equal(calls[0]!.headers["api-key"], undefined);
  });

  test("a failing token function is a provider error that does not fall back as a retry", async () => {
    const { calls, fetch } = recorder(() => chat("x"));
    const azure = azureOpenAI({ resource: "contoso", token: () => Promise.reject(new Error("no managed identity")), fetch });
    const ai = createAI({ providers: { azure }, models: { fast: "azure:gpt-5-mini" } });
    const error = await ai.generate({ model: "fast", prompt: "Hi" }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /no managed identity/);
    assert.equal(calls.length, 0);
    const empty = createAI({ providers: { azure: azureOpenAI({ resource: "contoso", token: () => "", fetch }) }, models: { fast: "azure:m" } });
    await assert.rejects(empty.generate({ model: "fast", prompt: "Hi" }), /returned no token/);
  });

  test("structured output, streaming with usage, and embeddings", async () => {
    const { calls, fetch } = recorder((call) =>
      call.url.endsWith("/embeddings")
        ? Response.json({ data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1 } })
        : call.body.stream
          ? sse([{ choices: [{ delta: { content: "Hi" } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }, "[DONE]"])
          : chat(JSON.stringify({ ok: true })),
    );
    const ai = createAI({ providers: { azure: azureOpenAI({ resource: "contoso", apiKey: "k", fetch }) }, models: { fast: "azure:chat", embed: "azure:embed-3-small" } });
    const { object } = await ai.generate({ model: "fast", prompt: "ok?", output: t.object({ ok: t.boolean() }) });
    assert.deepEqual(object, { ok: true });
    assert.equal(calls[0]!.body.response_format.type, "json_schema");
    const stream = ai.stream({ model: "fast", prompt: "Hi" });
    let text = "";
    for await (const chunk of stream) text += chunk;
    assert.equal(text, "Hi");
    assert.equal((await stream.usage()).inputTokens, 3);
    assert.deepEqual(calls[1]!.body.stream_options, { include_usage: true });
    assert.deepEqual((await ai.embed({ model: "embed", input: ["x"] })).embeddings, [[0.5]]);
    assert.equal(calls[2]!.url, "https://contoso.openai.azure.com/openai/v1/embeddings");
  });

  test("invalid options are IL5041 at startup", () => {
    const invalid = [
      {},
      { resource: "contoso" },
      { resource: "contoso", baseURL: "https://x.openai.azure.com/openai/v1", apiKey: "k" },
      { resource: "contoso", apiKey: "k", token: () => "t" },
      { resource: "contoso.openai.azure.com", apiKey: "k" },
      { resource: "contoso", apiKey: "" },
      { baseURL: "contoso.openai.azure.com", apiKey: "k" },
      { resource: "contoso", token: "eyJ..." },
    ];
    for (const options of invalid) {
      assert.throws(() => azureOpenAI(options as Parameters<typeof azureOpenAI>[0]), (e: unknown) => e instanceof InferloError && e.code === "IL5041", JSON.stringify(options));
    }
  });

  test("both adapters are exported from the AI entry point", () => {
    assert.equal(azureFromEntry, azureOpenAI);
    assert.equal(mistralFromEntry, mistral);
    assert.equal(vertexFromEntry, vertexAI);
  });
});

describe("vertexAI()", () => {
  test("calls the global OpenAI-compatible endpoint of the project with a fresh access token per request", async () => {
    const { calls, fetch } = recorder(() => chat("Hallo"));
    let n = 0;
    const vertex = vertexAI({ project: "acme-prod-42", token: async () => `ya29.token-${++n}`, fetch });
    const ai = createAI({ providers: { vertex }, models: { fast: "vertex:google/gemini-2.5-flash" } });
    assert.equal((await ai.generate({ model: "fast", prompt: "Hi" })).text, "Hallo");
    await ai.generate({ model: "fast", prompt: "Again" });
    assert.equal(calls[0]!.url, "https://aiplatform.googleapis.com/v1/projects/acme-prod-42/locations/global/endpoints/openapi/chat/completions");
    assert.equal(calls[0]!.body.model, "google/gemini-2.5-flash");
    assert.equal(calls[0]!.headers.authorization, "Bearer ya29.token-1");
    assert.equal(calls[1]!.headers.authorization, "Bearer ya29.token-2");
  });

  test("a region keeps requests on that region's host; structured output and streaming with tools", async () => {
    const { calls, fetch } = recorder((call) =>
      call.body.stream && call.body.messages.at(-1).role === "tool"
        ? sse([{ choices: [{ delta: { content: "Cold in Oslo" } }] }, "[DONE]"])
        : call.body.stream
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "weather", arguments: '{"city":"Oslo"}' } }] } }] },
            { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
            "[DONE]",
          ])
        : chat(JSON.stringify({ ok: true })),
    );
    const vertex = vertexAI({ project: "acme-prod-42", location: "europe-west4", token: () => "tok", fetch });
    const ai = createAI({ providers: { vertex }, models: { fast: "vertex:google/gemini-2.5-flash" } });
    const { object } = await ai.generate({ model: "fast", prompt: "ok?", output: t.object({ ok: t.boolean() }) });
    assert.deepEqual(object, { ok: true });
    assert.equal(calls[0]!.url, "https://europe-west4-aiplatform.googleapis.com/v1/projects/acme-prod-42/locations/europe-west4/endpoints/openapi/chat/completions");
    assert.equal(calls[0]!.body.response_format.type, "json_schema");
    const weather = tool("weather", { description: "Weather", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city }));
    const stream = ai.stream({ model: "fast", prompt: "Weather?", tools: [weather] });
    let text = "";
    for await (const chunk of stream) text += chunk;
    assert.equal(text, "Cold in Oslo");
    assert.equal((await stream.steps())[0]!.toolCalls[0]!.name, "weather");
    assert.equal(calls[1]!.body.tools[0].function.name, "weather");
  });

  test("a failing token is IL5006 without a request; invalid options are IL5041", async () => {
    const { calls, fetch } = recorder(() => chat("x"));
    const ai = createAI({ providers: { vertex: vertexAI({ project: "acme-prod-42", token: () => { throw new Error("no credentials"); }, fetch }) }, models: { fast: "vertex:google/gemini-2.5-flash" } });
    const error = await ai.generate({ model: "fast", prompt: "Hi" }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "IL5006");
    assert.match(error.message, /no credentials/);
    assert.equal(calls.length, 0);
    const invalid = [
      { token: () => "t" },
      { project: "", token: () => "t" },
      { project: "Acme_Prod", token: () => "t" },
      { project: "acme-prod-42", location: "europe west4", token: () => "t" },
      { project: "acme-prod-42", location: "evil.example.com/x", token: () => "t" },
      { project: "acme-prod-42" },
      { project: "acme-prod-42", token: "ya29.static" },
    ];
    for (const options of invalid) {
      assert.throws(() => vertexAI(options as Parameters<typeof vertexAI>[0]), (e: unknown) => e instanceof InferloError && e.code === "IL5041", JSON.stringify(options));
    }
  });
});
