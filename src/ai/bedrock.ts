/**
 * Amazon Bedrock through its Converse API: Anthropic Claude, Amazon Nova, Meta Llama, Mistral, Cohere and the other
 * models Bedrock serves, with chat, vision, tools and streaming, and Amazon Titan and Cohere embeddings.
 *
 *   providers: {
 *     bedrock: bedrock({ region: "eu-central-1", credentials: fromNodeProviderChain() }),  // IAM roles, SSO, profiles
 *     bedrockKey: bedrock({ region: "us-east-1", apiKey: env("AWS_BEARER_TOKEN_BEDROCK") }), // Bedrock API keys
 *   }
 *   models: { fast: "bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0", embed: "bedrock:amazon.titan-embed-text-v2:0" }
 *
 * Requests are signed with AWS Signature Version 4 on Web Crypto and sent with fetch: no AWS SDK and no runtime
 * dependency. Streams arrive in AWS's binary event stream format, decoded here with each frame's CRC checked.
 */
import { InferloError } from "../errors.ts";
import { holdSecrets } from "../redact.ts";
import { ALGORITHM, amzDate, canonicalPathOf, sha256Hex, signV4 } from "../sigv4.ts";
import { checkProviderOptions, imageData, invalidProvider, parseArguments, ProviderError } from "./providers.ts";
import type { Message, Provider, ProviderRequest, StreamPart, ToolCall } from "./providers.ts";

/** AWS credentials: an access key, with a session token for temporary credentials (IAM roles, STS, SSO). */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BedrockOptions {
  /** The AWS region, such as "us-east-1" or "eu-central-1". */
  region: string;
  /**
   * AWS credentials, or a function that returns them before each request (it should cache them until they expire),
   * such as fromNodeProviderChain() from @aws-sdk/credential-providers. Use either credentials or apiKey.
   */
  credentials?: AwsCredentials | (() => AwsCredentials | Promise<AwsCredentials>);
  /** An Amazon Bedrock API key (sent as a bearer token), instead of credentials. */
  apiKey?: string;
  /** Another endpoint for the Bedrock runtime API, such as a VPC interface endpoint (default https://bedrock-runtime.<region>.amazonaws.com). */
  baseURL?: string;
  fetch?: typeof fetch;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const IMAGE_FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };
/** Stream exception types and the HTTP status Bedrock gives the same error outside a stream. */
const STREAM_ERRORS: Record<string, number> = {
  throttlingException: 429,
  serviceUnavailableException: 503,
  internalServerException: 500,
  modelStreamErrorException: 500,
  validationException: 400,
  accessDeniedException: 403,
  resourceNotFoundException: 404,
};

export function bedrock(options: BedrockOptions): Provider {
  const name = "bedrock";
  checkProviderOptions("bedrock", { region: options.region }, ["region"]);
  if (!REGION.test(options.region)) throw invalidProvider("bedrock", `region must be an AWS region such as "us-east-1", got ${JSON.stringify(options.region)}.`);
  if ((options.credentials === undefined) === (options.apiKey === undefined)) {
    throw invalidProvider("bedrock", "needs either credentials (AWS access keys, or a function that returns them) or apiKey (an Amazon Bedrock API key), not both.");
  }
  if (options.apiKey !== undefined) checkProviderOptions("bedrock", { apiKey: options.apiKey }, ["apiKey"]);
  const credentials = options.credentials;
  if (credentials !== undefined && typeof credentials !== "function") {
    if (!credentials || typeof credentials !== "object") throw invalidProvider("bedrock", "credentials must be { accessKeyId, secretAccessKey, sessionToken? } or a function that returns them.");
    checkProviderOptions("bedrock", { "credentials.accessKeyId": credentials.accessKeyId, "credentials.secretAccessKey": credentials.secretAccessKey }, ["credentials.accessKeyId", "credentials.secretAccessKey"]);
  }
  if (options.baseURL !== undefined && !/^https?:\/\/[^/]/.test(options.baseURL)) throw invalidProvider("bedrock", `baseURL must be an http(s) URL, got ${JSON.stringify(options.baseURL)}.`);
  const base = (options.baseURL ?? `https://bedrock-runtime.${options.region}.amazonaws.com`).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  const currentCredentials = async (): Promise<AwsCredentials> => {
    if (typeof credentials !== "function") return credentials!;
    let value: AwsCredentials;
    try {
      value = await credentials();
    } catch (error) {
      throw new ProviderError(name, 401, `the credentials function failed: ${String((error as Error)?.message ?? error)}`);
    }
    if (!value || typeof value.accessKeyId !== "string" || !value.accessKeyId || typeof value.secretAccessKey !== "string" || !value.secretAccessKey) {
      throw new ProviderError(name, 401, "the credentials function returned no accessKeyId and secretAccessKey");
    }
    return value;
  };

  /** Signs (or adds the API key to) a POST to /model/<model>/<action> and sends it. */
  const send = async (model: string, action: string, body: unknown, signal: AbortSignal | undefined, accept = "application/json"): Promise<Response> => {
    const url = new URL(`${base}/model/${encodeURIComponent(model)}/${action}`);
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", accept };
    if (options.apiKey !== undefined) {
      headers.authorization = `Bearer ${options.apiKey}`;
    } else {
      const creds = await currentCredentials();
      const date = new Date();
      const signed: Record<string, string> = { "content-type": "application/json", "x-amz-date": amzDate(date).stamp };
      if (creds.sessionToken) signed["x-amz-security-token"] = creds.sessionToken;
      const signature = await signV4({
        method: "POST",
        url,
        headers: signed,
        payloadHash: await sha256Hex(payload),
        date,
        region: options.region,
        service: "bedrock",
        canonicalPath: canonicalPathOf(url),
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      });
      Object.assign(headers, signed);
      headers.authorization = `${ALGORITHM} Credential=${signature.credential}, SignedHeaders=${signature.signedHeaders}, Signature=${signature.signature}`;
    }
    let response: Response;
    try {
      response = await fetchImpl(url.href, { method: "POST", headers, body: payload, signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new ProviderError(name, 0, String((error as Error).message ?? error));
    }
    if (!response.ok) throw new ProviderError(name, response.status, await response.text().catch(() => ""));
    return response;
  };

  const converseBody = (r: ProviderRequest) => {
    const system = r.messages.filter((m) => m.role === "system" && m.content).map((m) => ({ text: m.content }));
    const out: Record<string, unknown> = { messages: converseMessages(r.messages) };
    if (system.length) out.system = system;
    const inference: Record<string, unknown> = {};
    if (r.maxTokens !== undefined) inference.maxTokens = r.maxTokens;
    if (r.temperature !== undefined) inference.temperature = r.temperature;
    if (Object.keys(inference).length) out.inferenceConfig = inference;
    if (r.tools?.length) out.toolConfig = { tools: r.tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } })) };
    return out;
  };

  const provider: Provider = {
    name,
    async generate(r) {
      const response = await send(r.model, "converse", converseBody(r), r.signal);
      const data = (await response.json()) as {
        output?: { message?: { content?: { text?: string; toolUse?: { toolUseId?: string; name?: string; input?: unknown } }[] } };
        usage?: { inputTokens?: number; outputTokens?: number };
      };
      const content = data.output?.message?.content ?? [];
      const text = content.map((block) => block.text ?? "").join("");
      const toolCalls: ToolCall[] = content.filter((block) => block.toolUse).map((block) => ({ id: block.toolUse!.toolUseId ?? "", name: block.toolUse!.name ?? "", input: block.toolUse!.input ?? {} }));
      return { text, usage: { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 }, ...(toolCalls.length ? { toolCalls } : {}) };
    },
    async *stream(r): AsyncIterable<StreamPart> {
      const response = await send(r.model, "converse-stream", converseBody(r), r.signal, "application/vnd.amazon.eventstream");
      // toolUse blocks start with the id and name; their input arrives as pieces of JSON.
      const calls = new Map<number, { id: string; name: string; json: string }>();
      for await (const message of eventStream(response.body!)) {
        const type = message.headers[":message-type"];
        if (type === "exception" || type === "error") {
          const kind = message.headers[":exception-type"] ?? message.headers[":error-code"] ?? "error";
          const text = new TextDecoder().decode(message.payload);
          throw new ProviderError(name, STREAM_ERRORS[kind] ?? 500, `${kind}: ${text}`);
        }
        const event = message.headers[":event-type"];
        const data = JSON.parse(new TextDecoder().decode(message.payload) || "{}") as {
          contentBlockIndex?: number;
          start?: { toolUse?: { toolUseId?: string; name?: string } };
          delta?: { text?: string; toolUse?: { input?: string } };
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        if (event === "contentBlockStart" && data.start?.toolUse) {
          calls.set(data.contentBlockIndex ?? calls.size, { id: data.start.toolUse.toolUseId ?? "", name: data.start.toolUse.name ?? "", json: "" });
        }
        if (event === "contentBlockDelta") {
          if (data.delta?.text) yield data.delta.text;
          if (data.delta?.toolUse?.input !== undefined) {
            const call = calls.get(data.contentBlockIndex ?? -1);
            if (call) call.json += data.delta.toolUse.input;
          }
        }
        if (event === "metadata" && data.usage) yield { usage: { inputTokens: data.usage.inputTokens ?? 0, outputTokens: data.usage.outputTokens ?? 0 } };
      }
      if (calls.size) yield { toolCalls: [...calls.values()].map((call) => ({ id: call.id, name: call.name, input: parseArguments(call.json) })) };
    },
    async embed({ model, input, signal }) {
      if (/(^|\.)cohere\.embed/.test(model)) {
        const embeddings: number[][] = [];
        let inputTokens = 0;
        // Cohere takes up to 96 texts per call.
        for (let i = 0; i < input.length; i += 96) {
          const response = await send(model, "invoke", { texts: input.slice(i, i + 96), input_type: "search_document", embedding_types: ["float"] }, signal);
          const data = (await response.json()) as { embeddings?: number[][] | { float?: number[][] } };
          const vectors = Array.isArray(data.embeddings) ? data.embeddings : (data.embeddings?.float ?? []);
          embeddings.push(...vectors);
          inputTokens += Number(response.headers.get("x-amzn-bedrock-input-token-count") ?? 0) || 0;
        }
        return { embeddings, usage: { inputTokens, outputTokens: 0 } };
      }
      if (/(^|\.)titan-embed/.test(model)) {
        // Titan embeds one text per call; up to 8 calls run at a time.
        const embeddings: number[][] = new Array(input.length);
        let inputTokens = 0;
        for (let i = 0; i < input.length; i += 8) {
          await Promise.all(input.slice(i, i + 8).map(async (text, j) => {
            const response = await send(model, "invoke", { inputText: text }, signal);
            const data = (await response.json()) as { embedding?: number[]; inputTextTokenCount?: number };
            embeddings[i + j] = data.embedding ?? [];
            inputTokens += data.inputTextTokenCount ?? 0;
          }));
        }
        return { embeddings, usage: { inputTokens, outputTokens: 0 } };
      }
      throw new InferloError("IL5005", `bedrock() embeds with Amazon Titan and Cohere embedding models, not "${model}".`, {
        fix: 'Use a model such as "bedrock:amazon.titan-embed-text-v2:0" or "bedrock:cohere.embed-v4:0" for embeddings.',
      });
    },
  };
  const secrets = [options.apiKey];
  if (credentials && typeof credentials === "object") secrets.push(credentials.secretAccessKey, credentials.sessionToken);
  return holdSecrets(provider, secrets);
}

/** Converse message shape: content blocks, tool calls as toolUse blocks, and consecutive tool results as one user message. */
function converseMessages(messages: Message[]): Record<string, unknown>[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }], status: m.isError ? "error" : "success" } };
      const last = out.at(-1);
      if (last && last.role === "user" && last.content.every((b) => "toolResult" in b)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    const content: Record<string, unknown>[] = [];
    for (const image of m.images ?? []) {
      const data = imageData(image);
      if (!data || !IMAGE_FORMATS[data.mediaType]) {
        throw new InferloError("IL5012", "bedrock() sends images as data: Bedrock's Converse API does not download image URLs.", {
          fix: "Pass the image as { base64, mediaType } or a data: URL of a PNG, JPEG, GIF or WebP image.",
        });
      }
      content.push({ image: { format: IMAGE_FORMATS[data.mediaType], source: { bytes: data.base64 } } });
    }
    if (m.content) content.push({ text: m.content });
    for (const call of m.toolCalls ?? []) content.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.input ?? {} } });
    out.push({ role: m.role, content });
  }
  return out;
}

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/**
 * Decodes AWS's binary event stream (application/vnd.amazon.eventstream): each frame is its total length, its
 * headers' length and a CRC32 of those 8 bytes, then the headers, the payload and a CRC32 of the whole frame.
 * String headers are returned; other header types are skipped. A damaged frame is a provider error.
 */
export async function* eventStream(body: ReadableStream<Uint8Array>): AsyncIterable<EventStreamMessage> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const damaged = (why: string) => new ProviderError("bedrock", 502, `damaged event stream: ${why}`);
  while (true) {
    while (buffer.length >= 12) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const total = view.getUint32(0);
      const headersLength = view.getUint32(4);
      if (crc32(buffer.subarray(0, 8)) !== view.getUint32(8)) throw damaged("prelude checksum mismatch");
      if (total < 16 + headersLength || total > 16 * 1024 * 1024) throw damaged(`invalid frame length ${total}`);
      if (buffer.length < total) break;
      if (crc32(buffer.subarray(0, total - 4)) !== view.getUint32(total - 4)) throw damaged("message checksum mismatch");
      yield { headers: eventHeaders(buffer.subarray(12, 12 + headersLength)), payload: buffer.slice(12 + headersLength, total - 4) };
      buffer = buffer.subarray(total);
    }
    const { value, done } = await reader.read();
    if (done) {
      if (buffer.length) throw damaged("the stream ended inside a frame");
      return;
    }
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer);
    next.set(value, buffer.length);
    buffer = next;
  }
}

/** Header value sizes by type: 0 and 1 are booleans (no value), 2 byte, 3 short, 4 int, 5 long, 8 timestamp, 9 uuid; 6 and 7 have a 2-byte length. */
const FIXED_SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

function eventHeaders(bytes: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = view.getUint8(offset);
    const name = decoder.decode(bytes.subarray(offset + 1, offset + 1 + nameLength));
    offset += 1 + nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    if (type === 6 || type === 7) {
      const length = view.getUint16(offset);
      if (type === 7) headers[name] = decoder.decode(bytes.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
    } else if (type in FIXED_SIZES) {
      offset += FIXED_SIZES[type]!;
    } else {
      throw new ProviderError("bedrock", 502, `damaged event stream: unknown header type ${type}`);
    }
  }
  return headers;
}

let crcTable: Uint32Array | undefined;

/** CRC32 (IEEE 802.3), as the event stream format uses it. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
