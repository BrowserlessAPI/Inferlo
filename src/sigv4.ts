/**
 * AWS Signature Version 4 on Web Crypto, shared by s3Storage() and the bedrock() AI provider. No AWS SDK and no
 * Node.js APIs, so it runs wherever Inferlo runs.
 */
export const ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 needs it: everything but A-Z a-z 0-9 - . _ ~ is percent-encoded. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** "20261107T201500Z" and "20261107" for a date. */
export function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp, day: stamp.slice(0, 8) };
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign (lower-case names). host is added from the URL. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  date: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
  /**
   * The path as it goes into the canonical request, when it differs from the URL's path. Services other than S3
   * encode the (already encoded) path a second time; see canonicalPathOf().
   */
  canonicalPath?: string;
}

export function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * AWS Signature Version 4 for one request. Returns the signature and the parts of the Authorization header. The
 * URL's path must already be encoded once (S3 does not encode it a second time).
 */
export async function signV4(input: SignInput): Promise<{ signature: string; signedHeaders: string; scope: string; credential: string }> {
  const service = input.service ?? "s3";
  const { stamp, day } = amzDate(input.date);
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.canonicalPath ?? (input.url.pathname || "/"),
    canonicalQuery(input.url),
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return { signature, signedHeaders, scope, credential: `${input.accessKeyId}/${scope}` };
}


/** The canonical path for services other than S3: each segment of the encoded path is encoded again. */
export function canonicalPathOf(url: URL): string {
  return (url.pathname || "/").split("/").map((segment) => uriEncode(segment)).join("/");
}
