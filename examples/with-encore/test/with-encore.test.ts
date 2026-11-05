// Runs the example's Encore endpoints with the real encore.dev package. Encore's native runtime only exists
// inside the Encore CLI, so encore-runtime.cjs stands in for it, and each raw endpoint call gets Encore's own
// RawRequest and RawResponse objects, built the way the runtime builds them.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";

process.env.ENCORE_RUNTIME_LIB = fileURLToPath(new URL("./encore-runtime.cjs", import.meta.url));

// Answer Anthropic API calls like the Messages API; structured output asks for JSON.
const anthropicCalls: { apiKey: string | null; body: { messages: { content: unknown }[] } }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body));
  anthropicCalls.push({ apiKey: new Headers(init?.headers).get("x-api-key"), body });
  const text = JSON.stringify(body).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.";
  return Response.json({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });
}) as typeof fetch;

type Encore = typeof import("encore.dev/api");
type Api = typeof import("../ai/api.ts");
let encore: Encore;
let endpoints: Api;
before(async () => {
  encore = await import("encore.dev/api");
  endpoints = await import("../ai/api.ts");
});

interface Answer {
  status: number;
  headers: Record<string, string | number | string[]>;
  body: string;
}

/** The body of a raw request, streamed like the runtime's native BodyReader: chunks, then the end. */
class BodyReader {
  #chunks: Buffer[];
  #push: ((chunk: Buffer | null) => void) | undefined;
  constructor(chunks: Buffer[]) {
    this.#chunks = chunks;
  }
  start(push: (chunk: Buffer | null) => void) {
    this.#push = push;
  }
  read() {
    if (!this.#push) return;
    const push = this.#push;
    this.#push = undefined;
    for (const chunk of this.#chunks) push(chunk);
    push(null);
  }
}

/** Call a raw endpoint the way Encore's runtime does: with its RawRequest and RawResponse. */
async function callRaw(handler: (req: never, res: never) => unknown, method: string, pathAndQuery: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  const meta = { apiCall: { method, pathAndQuery, headers: { host: "localhost:4000", ...headers } } };
  const reader = new BodyReader(body === undefined ? [] : [Buffer.from(body)]);
  const answer: Answer = { status: 0, headers: {}, body: "" };
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    const writer = {
      writeHead(status: number, outHeaders: Answer["headers"]) {
        answer.status = status;
        answer.headers = outHeaders;
      },
      writeBody(chunk: Uint8Array, callback: () => void) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      writeBodyMulti(list: Uint8Array[], callback: () => void) {
        for (const chunk of list) chunks.push(Buffer.from(chunk));
        callback();
      },
      close(_error: unknown, callback: () => void) {
        callback();
        resolve();
      },
    };
    const RawRequest = encore.RawRequest as unknown as new (req: unknown, body: unknown) => object;
    const RawResponse = encore.RawResponse as unknown as new (req: object, writer: unknown) => object;
    const req = new RawRequest({ meta: () => meta }, reader);
    handler(req as never, new RawResponse(req, writer) as never);
  });
  await done;
  answer.body = Buffer.concat(chunks).toString("utf8");
  return answer;
}

const json = { "content-type": "application/json" };

test("a typed Encore endpoint uses Inferlo's AI module with structured output", async () => {
  assert.deepEqual(await endpoints.classify({ text: "How do I export?" }), { label: "question" });
  assert.equal(anthropicCalls.at(-1)?.apiKey, "test-AnthropicApiKey", "the API key comes from the Encore secret");
});

test("the raw endpoint serves the Inferlo app under /inferlo with its auth and validation", async () => {
  const handler = endpoints.inferloApp as unknown as (req: never, res: never) => unknown;
  const body = JSON.stringify({ text: "A long text." });

  const anonymous = await callRaw(handler, "POST", "/inferlo/summaries", json, body);
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.parse(anonymous.body).error.code, "IL3001");

  const signedIn = { ...json, authorization: "Bearer demo-token" };
  assert.equal((await callRaw(handler, "POST", "/inferlo/summaries", signedIn, JSON.stringify({ text: "" }))).status, 422);

  const ok = await callRaw(handler, "POST", "/inferlo/summaries", signedIn, body);
  assert.equal(ok.status, 200, ok.body);
  assert.match(String(ok.headers["content-type"]), /application\/json/);
  assert.deepEqual(JSON.parse(ok.body), { summary: "A short summary." });
  assert.ok(ok.headers["x-request-id"], "Inferlo's response headers reach Encore");
});

test("the raw endpoint serves the app's OpenAPI document and 404s under the prefix", async () => {
  const handler = endpoints.inferloApp as unknown as (req: never, res: never) => unknown;
  const openapi = await callRaw(handler, "GET", "/inferlo/openapi.json");
  assert.equal(openapi.status, 200);
  assert.ok(JSON.parse(openapi.body).paths["/summaries"]);
  assert.equal((await callRaw(handler, "GET", "/inferlo/nothing-here")).status, 404);
});
