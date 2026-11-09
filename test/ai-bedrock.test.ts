import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { bedrock, createAI, InferloError, ProviderError, t, tool } from "../src/index.ts";
import { bedrock as bedrockFromEntry } from "../src/ai/public.ts";
import { crc32, eventStream } from "../src/ai/bedrock.ts";
import { secretsOf } from "../src/redact.ts";

// Amazon Bedrock adapter on the Converse API. Requests are checked as Bedrock receives them, including an independent
// SigV4 check written with node:crypto (the signer itself runs on Web Crypto). The signature was also compared with the
// AWS SDK's own signer (@smithy/signature-v4) for a model id with ":" in it, which is encoded twice in the canonical path.

interface Call {
  url: string;
  headers: Record<string, string>;
  raw: string;
  body: Record<string, any>;
}

function recorder(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    const raw = String(init!.body);
    const call = { url: String(url), headers: Object.fromEntries(new Headers(init!.headers).entries()), raw, body: JSON.parse(raw) };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetch };
}

const converse = (content: unknown[], usage = { inputTokens: 11, outputTokens: 3 }) => Response.json({ output: { message: { role: "assistant", content } }, stopReason: "end_turn", usage });

const KEYS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

/** The SigV4 signature AWS expects for a recorded call, computed with node:crypto. */
function expectedSignature(call: Call, region: string, secret: string): string {
  const url = new URL(call.url);
  const signed = call.headers.authorization!.match(/SignedHeaders=([^,]+)/)![1]!.split(";");
  const canonicalPath = url.pathname.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  const headers = signed.map((name) => `${name}:${name === "host" ? url.host : call.headers[name]}\n`).join("");
  const request = ["POST", canonicalPath, "", headers, signed.join(";"), createHash("sha256").update(call.raw).digest("hex")].join("\n");
  const date = call.headers["x-amz-date"]!;
  const scope = `${date.slice(0, 8)}/${region}/bedrock/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(request).digest("hex")].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${secret}`).update(date.slice(0, 8)).digest();
  for (const part of [region, "bedrock", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex");
}

/** One event stream frame, as Bedrock sends it. */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const headerBytes: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xff, ...v);
  }
  const body = encoder.encode(JSON.stringify(payload));
  const total = 16 + headerBytes.length + body.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

const event = (type: string, payload: unknown) => frame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, payload);

/** A stream response that delivers the frames in small pieces, so frames are split across reads. */
function eventResponse(frames: Uint8Array[], pieceSize = 7): Response {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    all.set(f, offset);
    offset += f.length;
  }
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position >= all.length) return controller.close();
      controller.enqueue(all.slice(position, position + pieceSize));
      position += pieceSize;
    },
  });
  return new Response(body, { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

describe("bedrock()", () => {
  test("calls Converse in the region with a SigV4 signature, the system prompt and inference settings", async () => {
    const { calls, fetch } = recorder(() => converse([{ text: "Hallo" }]));
    const ai = createAI({ providers: { bedrock: bedrock({ region: "eu-central-1", credentials: { ...KEYS, sessionToken: "session/token+1" }, fetch }) }, models: { fast: "bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0" } });
    const result = await ai.generate({ model: "fast", system: "Be brief.", prompt: "Hi", maxTokens: 50, temperature: 0.2 });
    assert.equal(result.text, "Hallo");
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(result.usage.outputTokens, 3);
    const call = calls[0]!;
    assert.equal(call.url, "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
    assert.deepEqual(call.body.system, [{ text: "Be brief." }]);
    assert.deepEqual(call.body.messages, [{ role: "user", content: [{ text: "Hi" }] }]);
    assert.deepEqual(call.body.inferenceConfig, { maxTokens: 50, temperature: 0.2 });
    assert.equal(call.headers["x-amz-security-token"], "session/token+1");
    assert.match(call.headers["x-amz-date"]!, /^\d{8}T\d{6}Z$/);
    assert.match(call.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    assert.equal(call.headers.authorization!.split("Signature=")[1], expectedSignature(call, "eu-central-1", KEYS.secretAccessKey));
    assert.equal(bedrockFromEntry, bedrock);
  });

  test("an API key is sent as a bearer token; credentials from a function are fetched for each request", async () => {
    const { calls, fetch } = recorder(() => converse([{ text: "ok" }]));
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-east-1", apiKey: "ABSKexamplekey", fetch }) }, models: { fast: "bedrock:amazon.nova-micro-v1:0" } });
    await ai.generate({ model: "fast", prompt: "Hi" });
    assert.equal(calls[0]!.headers.authorization, "Bearer ABSKexamplekey");
    assert.equal(calls[0]!.headers["x-amz-date"], undefined);
    let n = 0;
    const rotating = bedrock({ region: "us-east-1", credentials: async () => ({ accessKeyId: `AKID${++n}`, secretAccessKey: `secret-${n}` }), fetch });
    const ai2 = createAI({ providers: { bedrock: rotating }, models: { fast: "bedrock:amazon.nova-micro-v1:0" } });
    await ai2.generate({ model: "fast", prompt: "One" });
    await ai2.generate({ model: "fast", prompt: "Two" });
    assert.match(calls[1]!.headers.authorization!, /Credential=AKID1\//);
    assert.match(calls[2]!.headers.authorization!, /Credential=AKID2\//);
    assert.equal(calls[2]!.headers.authorization!.split("Signature=")[1], expectedSignature(calls[2]!, "us-east-1", "secret-2"));
    assert.ok(secretsOf(bedrock({ region: "us-east-1", apiKey: "ABSKexamplekey" })).includes("ABSKexamplekey"));
    assert.ok(secretsOf(bedrock({ region: "us-east-1", credentials: KEYS })).includes(KEYS.secretAccessKey));
  });

  test("images, tool calls and tool results use Converse content blocks", async () => {
    const { calls, fetch } = recorder((call) =>
      call.body.messages.length === 1
        ? converse([{ text: "Checking." }, { toolUse: { toolUseId: "tu-1", name: "weather", input: { city: "Oslo" } } }])
        : converse([{ text: "Cold in Oslo" }]),
    );
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-east-1", credentials: KEYS, fetch }) }, models: { fast: "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0" } });
    const weather = tool("weather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, celsius: -3 }));
    const result = await ai.generate({ model: "fast", prompt: "Weather here?", images: [{ base64: "iVBORw0KGgo=", mediaType: "image/png" }], tools: [weather] });
    assert.equal(result.text, "Cold in Oslo");
    assert.deepEqual(calls[0]!.body.messages[0].content, [{ image: { format: "png", source: { bytes: "iVBORw0KGgo=" } } }, { text: "Weather here?" }]);
    assert.deepEqual(calls[0]!.body.toolConfig.tools[0].toolSpec.name, "weather");
    assert.equal(calls[0]!.body.toolConfig.tools[0].toolSpec.inputSchema.json.type, "object");
    const [, assistant, results] = calls[1]!.body.messages;
    assert.deepEqual(assistant, { role: "assistant", content: [{ text: "Checking." }, { toolUse: { toolUseId: "tu-1", name: "weather", input: { city: "Oslo" } } }] });
    assert.equal(results.role, "user");
    assert.equal(results.content[0].toolResult.toolUseId, "tu-1");
    assert.equal(results.content[0].toolResult.status, "success");
    assert.match(results.content[0].toolResult.content[0].text, /-3/);
    const error = await ai.generate({ model: "fast", prompt: "Look", images: [{ url: "https://example.com/cat.png" }] }).catch((e: unknown) => e);
    assert.ok(error instanceof InferloError);
    assert.equal(error.code, "IL5012");
    assert.equal(calls.length, 2);
  });

  test("structured output is validated like every provider's", async () => {
    const { fetch } = recorder(() => converse([{ text: '{"city":"Paris","population":2100000}' }]));
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-east-1", credentials: KEYS, fetch }) }, models: { fast: "bedrock:amazon.nova-lite-v1:0" } });
    const { object } = await ai.generate({ model: "fast", prompt: "Capital of France?", output: t.object({ city: t.string(), population: t.int() }) });
    assert.deepEqual(object, { city: "Paris", population: 2100000 });
  });

  test("streams text and tool calls from the binary event stream", async () => {
    const { calls, fetch } = recorder((call) =>
      call.body.messages.at(-1).content[0].toolResult
        ? eventResponse([
            event("messageStart", { role: "assistant" }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Cold " } }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "in Oslo" } }),
            event("messageStop", { stopReason: "end_turn" }),
            event("metadata", { usage: { inputTokens: 20, outputTokens: 4 }, metrics: { latencyMs: 100 } }),
          ])
        : eventResponse([
            event("messageStart", { role: "assistant" }),
            event("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu-9", name: "weather" } } }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } }),
            event("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '"Oslo"}' } } }),
            event("contentBlockStop", { contentBlockIndex: 0 }),
            event("messageStop", { stopReason: "tool_use" }),
            event("metadata", { usage: { inputTokens: 10, outputTokens: 2 } }),
          ]),
    );
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-west-2", credentials: KEYS, fetch }) }, models: { fast: "bedrock:us.amazon.nova-pro-v1:0" } });
    const weather = tool("weather", { description: "Weather", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city }));
    const stream = ai.stream({ model: "fast", prompt: "Weather?", tools: [weather] });
    let text = "";
    for await (const chunk of stream) text += chunk;
    assert.equal(text, "Cold in Oslo");
    const steps = await stream.steps();
    assert.deepEqual(steps[0]!.toolCalls[0]!.input, { city: "Oslo" });
    assert.equal(calls[0]!.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.amazon.nova-pro-v1%3A0/converse-stream");
    assert.equal(calls[0]!.headers.accept, "application/vnd.amazon.eventstream");
    assert.equal((await stream.usage()).inputTokens, 30);
  });

  test("stream exceptions and damaged frames are provider errors", async () => {
    const throttled = frame({ ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" }, { message: "Too many requests" });
    const { fetch } = recorder(() => eventResponse([event("messageStart", { role: "assistant" }), throttled]));
    const provider = bedrock({ region: "us-east-1", credentials: KEYS, fetch });
    const parts: unknown[] = [];
    const error = await (async () => {
      for await (const part of provider.stream!({ model: "amazon.nova-micro-v1:0", messages: [{ role: "user", content: "Hi" }] })) parts.push(part);
    })().catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /throttlingException/);
    const damaged = event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } });
    damaged[damaged.length - 20]! ^= 0xff;
    const broken = await (async () => {
      for await (const _ of eventStream(eventResponse([damaged]).body!)) void _;
    })().catch((e: unknown) => e);
    assert.ok(broken instanceof ProviderError);
    assert.match(broken.message, /checksum/);
    const cut = await (async () => {
      for await (const _ of eventStream(eventResponse([damaged.slice(0, 30)]).body!)) void _;
    })().catch((e: unknown) => e);
    assert.ok(cut instanceof ProviderError);
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  });

  test("HTTP errors: throttling is retryable on a fallback model, access denied is not", async () => {
    let n = 0;
    const { fetch } = recorder(() => (++n === 1 ? Response.json({ message: "Rate exceeded" }, { status: 429, headers: { "x-amzn-errortype": "ThrottlingException" } }) : converse([{ text: "from fallback" }])));
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-east-1", credentials: KEYS, fetch }) }, models: { fast: ["bedrock:amazon.nova-micro-v1:0", "bedrock:amazon.nova-lite-v1:0"] } });
    assert.equal((await ai.generate({ model: "fast", prompt: "Hi" })).text, "from fallback");
    const denied = bedrock({ region: "us-east-1", credentials: KEYS, fetch: async () => Response.json({ message: "not authorized" }, { status: 403 }) });
    const error = await denied.generate({ model: "amazon.nova-micro-v1:0", messages: [{ role: "user", content: "Hi" }] }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /wJalr/);
  });

  test("Titan and Cohere embeddings through InvokeModel", async () => {
    const { calls, fetch } = recorder((call) =>
      call.url.includes("titan")
        ? Response.json({ embedding: [call.body.inputText.length, 1], inputTextTokenCount: 2 })
        : Response.json({ id: "x", embeddings: { float: call.body.texts.map((s: string) => [s.length, 2]) } }, { headers: { "x-amzn-bedrock-input-token-count": "7" } }),
    );
    const ai = createAI({ providers: { bedrock: bedrock({ region: "us-east-1", credentials: KEYS, fetch }) }, models: { embed: "bedrock:amazon.titan-embed-text-v2:0", cohere: "bedrock:cohere.embed-v4:0" } });
    const titan = await ai.embed({ input: ["a", "bb", "ccc"] });
    assert.deepEqual(titan.embeddings, [[1, 1], [2, 1], [3, 1]]);
    assert.equal(titan.usage.inputTokens, 6);
    assert.equal(calls[0]!.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke");
    const many = Array.from({ length: 100 }, (_, i) => "x".repeat(i + 1));
    const cohere = await ai.embed({ model: "cohere", input: many });
    assert.equal(cohere.embeddings.length, 100);
    assert.deepEqual(cohere.embeddings[99], [100, 2]);
    assert.equal(cohere.usage.inputTokens, 14);
    const cohereCalls = calls.filter((c) => c.url.includes("cohere"));
    assert.equal(cohereCalls.length, 2);
    assert.equal(cohereCalls[0]!.body.texts.length, 96);
    assert.equal(cohereCalls[0]!.body.input_type, "search_document");
    const other = await bedrock({ region: "us-east-1", credentials: KEYS, fetch }).embed!({ model: "amazon.nova-micro-v1:0", input: ["a"] }).catch((e: unknown) => e);
    assert.ok(other instanceof InferloError);
    assert.equal(other.code, "IL5005");
  });

  test("a failing credentials function is IL5006 without a request; invalid options are IL5041", async () => {
    const { calls, fetch } = recorder(() => converse([{ text: "x" }]));
    const provider = bedrock({ region: "us-east-1", credentials: () => { throw new Error("no credentials found"); }, fetch });
    const error = await provider.generate({ model: "amazon.nova-micro-v1:0", messages: [{ role: "user", content: "Hi" }] }).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "IL5006");
    assert.equal(error.retryable, false);
    assert.match(error.message, /no credentials found/);
    assert.equal(calls.length, 0);
    const invalid = [
      { credentials: KEYS },
      { region: "", credentials: KEYS },
      { region: "us east 1", credentials: KEYS },
      { region: "evil.example.com/x", credentials: KEYS },
      { region: "us-east-1" },
      { region: "us-east-1", credentials: KEYS, apiKey: "k" },
      { region: "us-east-1", apiKey: "" },
      { region: "us-east-1", credentials: { accessKeyId: "AKID" } },
      { region: "us-east-1", credentials: "AKID:secret" },
      { region: "us-east-1", credentials: KEYS, baseURL: "bedrock.internal" },
    ];
    for (const options of invalid) {
      assert.throws(() => bedrock(options as Parameters<typeof bedrock>[0]), (e: unknown) => e instanceof InferloError && e.code === "IL5041", JSON.stringify(options));
    }
    const vpc = recorder(() => converse([{ text: "ok" }]));
    await bedrock({ region: "eu-west-1", credentials: KEYS, baseURL: "https://vpce-123.bedrock-runtime.eu-west-1.vpce.amazonaws.com/", fetch: vpc.fetch }).generate({ model: "amazon.nova-micro-v1:0", messages: [{ role: "user", content: "Hi" }] });
    assert.equal(vpc.calls[0]!.url, "https://vpce-123.bedrock-runtime.eu-west-1.vpce.amazonaws.com/model/amazon.nova-micro-v1%3A0/converse");
    assert.equal(vpc.calls[0]!.headers.authorization!.split("Signature=")[1], expectedSignature(vpc.calls[0]!, "eu-west-1", KEYS.secretAccessKey));
  });
});
