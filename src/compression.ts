/**
 * Response compression: createApp({ compression: true }) compresses answers with gzip or deflate (the encodings of
 * the Web CompressionStream, on every runtime) when the client accepts one and the answer is worth compressing.
 *
 * Compressed: text, JSON, JavaScript, XML and SVG answers of at least `threshold` bytes (1024 by default; answers
 * whose size is unknown, such as streams, count as large enough). Never compressed: HEAD requests, 1xx, 204, 206 and
 * 304 answers, Server-Sent Events (AI streams stay live), answers that already have a Content-Encoding, and answers
 * with Cache-Control: no-transform. Compressible answers get Vary: Accept-Encoding, so caches keep both versions.
 */
import { InferloError } from "./errors.ts";
import { knownBodies } from "./response-body.ts";

export type CompressionEncoding = "gzip" | "deflate";

export interface CompressionConfig {
  /** Smallest answer, in bytes, that is compressed. Default 1024. */
  threshold?: number;
  /** Encodings to offer, in order of preference. Default ["gzip", "deflate"]. */
  encodings?: CompressionEncoding[];
}

export interface ResolvedCompression {
  threshold: number;
  encodings: CompressionEncoding[];
}

const ENCODINGS: readonly CompressionEncoding[] = ["gzip", "deflate"];
const fix = 'Use createApp({ compression: true }) or createApp({ compression: { threshold: 1024, encodings: ["gzip", "deflate"] } }).';

/** Checks createApp({ compression }) at startup. Raises IL6063. */
export function resolveCompression(option: unknown): ResolvedCompression | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { threshold: 1024, encodings: [...ENCODINGS] };
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    throw new InferloError("IL6063", `createApp({ compression }) must be true, false or { threshold, encodings }, got ${Array.isArray(option) ? "an array" : option === null ? "null" : typeof option}.`, { fix });
  }
  const unknown = Object.keys(option).filter((key) => key !== "threshold" && key !== "encodings");
  if (unknown.length) throw new InferloError("IL6063", `createApp({ compression }) has unknown option ${unknown.map((k) => `"${k}"`).join(", ")}.`, { fix });
  const { threshold = 1024, encodings = [...ENCODINGS] } = option as CompressionConfig;
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0 || threshold > 1_073_741_824) {
    throw new InferloError("IL6063", `compression.threshold must be a whole number of bytes from 0 to 1073741824, got ${JSON.stringify(threshold)}.`, { fix });
  }
  if (!Array.isArray(encodings) || encodings.length === 0 || encodings.some((e) => !ENCODINGS.includes(e)) || new Set(encodings).size !== encodings.length) {
    throw new InferloError("IL6063", `compression.encodings must list "gzip" and/or "deflate" once each, got ${JSON.stringify(encodings)}.`, { fix });
  }
  return { threshold, encodings: [...encodings] };
}

const COMPRESSIBLE = /^(text\/(?!event-stream)[\w.+-]+|application\/(json|[\w.+-]+\+json|javascript|ecmascript|xml|[\w.+-]+\+xml|x-ndjson|graphql-response\+json|x-www-form-urlencoded)|image\/svg\+xml)$/;

/** The encoding to use for an Accept-Encoding header: the first configured encoding the client accepts (q > 0). */
export function chooseEncoding(acceptEncoding: string | null, encodings: readonly CompressionEncoding[]): CompressionEncoding | undefined {
  if (!acceptEncoding) return undefined;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key === "q" && value !== undefined) q = Number(value);
    }
    accepted.set(name.trim(), Number.isFinite(q) ? q : 0);
  }
  for (const encoding of encodings) {
    const q = accepted.get(encoding) ?? accepted.get("*");
    if (q !== undefined && q > 0) return encoding;
  }
  return undefined;
}

function addVary(headers: Headers): void {
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Accept-Encoding");
  else if (vary.trim() !== "*" && !vary.split(",").some((v) => v.trim().toLowerCase() === "accept-encoding")) headers.set("vary", `${vary}, Accept-Encoding`);
}

/** Compresses a response when the request and the response allow it; otherwise returns it as it is. */
export function compressResponse(response: Response, request: Request, config: ResolvedCompression): Response {
  const status = response.status;
  if (!response.body || status < 200 || status === 204 || status === 206 || status === 304) return response;
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!COMPRESSIBLE.test(type)) return response;
  if (response.headers.has("content-encoding") || /(^|,)\s*no-transform\s*(,|$)/i.test(response.headers.get("cache-control") ?? "")) return response;
  const known = knownBodies.get(response);
  const length = known !== undefined ? new TextEncoder().encode(known).byteLength : Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(length) && length < config.threshold) return response;
  const headers = new Headers(response.headers);
  addVary(headers);
  const encoding = request.method.toUpperCase() === "HEAD" ? undefined : chooseEncoding(request.headers.get("accept-encoding"), config.encodings);
  if (!encoding) {
    if (headers.get("vary") === response.headers.get("vary")) return response;
    try {
      response.headers.set("vary", headers.get("vary")!);
      return response;
    } catch {
      // Immutable headers (a fetch() response passed through): copy the response.
      return new Response(response.body, { status, statusText: response.statusText, headers });
    }
  }
  headers.delete("content-length");
  headers.set("content-encoding", encoding);
  // The compressed bytes differ from the uncompressed ones, so a strong ETag becomes weak (RFC 9110, 8.8.3).
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  const body = response.body.pipeThrough(new CompressionStream(encoding) as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Response(body, { status, statusText: response.statusText, headers });
}
