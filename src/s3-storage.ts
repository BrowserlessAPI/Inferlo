/**
 * s3Storage({ bucket, region, accessKeyId, secretAccessKey }): files in an S3-compatible object store (AWS S3,
 * Cloudflare R2, MinIO and others), with signed download URLs through storage.url(key, { expiresIn }).
 *
 *   storage: s3Storage({
 *     bucket: env("S3_BUCKET"),
 *     region: env("S3_REGION"),                          // "auto" on Cloudflare R2
 *     endpoint: env("S3_ENDPOINT", { default: "" }) || undefined, // leave out for AWS S3
 *     accessKeyId: env("S3_ACCESS_KEY_ID"),
 *     secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
 *   })
 *
 * Requests are signed with AWS Signature Version 4 on Web Crypto and sent with fetch: no AWS SDK, no runtime
 * dependency, and it runs wherever Inferlo runs. The secret key never leaves this module: it is only used to derive
 * the day's signing key, and errors name the bucket, the operation and S3's error code, never a credential.
 */
import { InferloError } from "./errors.ts";
import type { StorageStore } from "./storage.ts";
import { ALGORITHM, amzDate, sha256Hex, signV4, uriEncode } from "./sigv4.ts";

export { amzDate, signV4, uriEncode };

export interface S3StorageOptions {
  /** The bucket name, for example "acme-uploads". */
  bucket: string;
  /** The bucket's region, for example "eu-central-1". Cloudflare R2 uses "auto"; MinIO usually "us-east-1". */
  region: string;
  /** Access key id of a key that may read, write and delete objects in the bucket. */
  accessKeyId: string;
  /** Its secret access key. Read it with env(); it is never logged or put in an error. */
  secretAccessKey: string;
  /** Session token, for temporary credentials (AWS STS, an IAM role). */
  sessionToken?: string;
  /**
   * The S3 API endpoint for stores other than AWS S3, for example "https://<account>.r2.cloudflarestorage.com" or
   * "http://localhost:9000" (MinIO). https is required except on localhost. Default: AWS S3 in the region.
   */
  endpoint?: string;
  /**
   * Address the bucket in the path (https://endpoint/bucket/key) instead of the host name
   * (https://bucket.endpoint/key). Default: true with an endpoint (MinIO, R2), false on AWS S3.
   */
  pathStyle?: boolean;
  /** Time limit for each request to the store, in milliseconds (1000 to 300000, default 30000). */
  timeoutMs?: number;
}

const UNSIGNED = "UNSIGNED-PAYLOAD";
const OPTION_KEYS = new Set(["bucket", "region", "accessKeyId", "secretAccessKey", "sessionToken", "endpoint", "pathStyle", "timeoutMs"]);
/** S3 bucket names: 3 to 63 lowercase letters, digits, dots and dashes (R2 and MinIO follow the same rules). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,40}$/;

function invalid(why: string): InferloError {
  return new InferloError("IL6048", `Invalid s3Storage() options: ${why}.`, {
    fix: 's3Storage({ bucket: env("S3_BUCKET"), region: env("S3_REGION"), accessKeyId: env("S3_ACCESS_KEY_ID"), secretAccessKey: env("S3_SECRET_ACCESS_KEY") }), plus endpoint for R2 or MinIO (https, except on localhost).',
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** S3's error code from an XML error body (<Code>AccessDenied</Code>), if there is one. */
function s3ErrorCode(body: string): string | undefined {
  const match = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(body);
  return match?.[1];
}

export function s3Storage(options: S3StorageOptions): StorageStore {
  if (!options || typeof options !== "object") throw invalid("pass an options object");
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option "${key}"`);
  const { bucket, region, accessKeyId, secretAccessKey, sessionToken } = options;
  if (typeof bucket !== "string" || !BUCKET.test(bucket) || bucket.includes("..")) throw invalid(`bucket must be an S3 bucket name (3 to 63 lowercase letters, digits, "." and "-"), got ${JSON.stringify(bucket)}`);
  if (typeof region !== "string" || !REGION.test(region)) throw invalid(`region must be a region name such as "eu-central-1" or "auto", got ${JSON.stringify(region)}`);
  if (typeof accessKeyId !== "string" || accessKeyId.trim() === "" || /\s|\//.test(accessKeyId)) throw invalid("accessKeyId must be a non-empty access key id");
  if (typeof secretAccessKey !== "string" || secretAccessKey === "") throw invalid("secretAccessKey must be a non-empty string");
  if (sessionToken !== undefined && (typeof sessionToken !== "string" || sessionToken === "")) throw invalid("sessionToken must be a non-empty string when given");
  if (options.pathStyle !== undefined && typeof options.pathStyle !== "boolean") throw invalid("pathStyle must be true or false");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw invalid("timeoutMs must be a whole number of milliseconds from 1000 to 300000");

  let base: URL;
  if (options.endpoint !== undefined) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw invalid(`endpoint must be a URL such as "https://<account>.r2.cloudflarestorage.com", got ${JSON.stringify(options.endpoint)}`);
    }
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))) throw invalid("endpoint must use https (http is allowed on localhost only)");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) throw invalid("endpoint is the store's origin only, without a path, query or credentials; the bucket goes in the bucket option");
    base = endpoint;
  } else {
    base = new URL(`https://s3.${region}.amazonaws.com`);
  }
  const pathStyle = options.pathStyle ?? options.endpoint !== undefined;
  if (!pathStyle && bucket.includes(".") && base.protocol === "https:") throw invalid("bucket names with dots need pathStyle: true, because their host name does not match the store's TLS certificate");

  const objectUrl = (key: string): URL => {
    const path = key.split("/").map((s) => uriEncode(s)).join("/");
    return pathStyle ? new URL(`${base.origin}/${uriEncode(bucket)}/${path}`) : new URL(`${base.protocol}//${bucket}.${base.host}/${path}`);
  };

  const fail = (operation: string, key: string, detail: string): InferloError =>
    new InferloError("IL6049", `S3 ${operation} of "${key}" in bucket "${bucket}" failed: ${detail}.`, {
      status: 502,
      fix: "Check that the bucket exists in this region and endpoint, that the access key may read, write and delete objects in it (s3:GetObject, s3:PutObject, s3:DeleteObject), that the server clock is correct, and that the store is reachable.",
    });

  const send = async (operation: string, method: string, key: string, body?: Uint8Array, type?: string): Promise<Response> => {
    const url = objectUrl(key);
    const date = new Date();
    const payloadHash = body ? await sha256Hex(body) : await sha256Hex("");
    const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate(date).stamp };
    if (type) headers["content-type"] = type;
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;
    const signed = await signV4({ method, url, headers, payloadHash, date, region, accessKeyId, secretAccessKey });
    headers.authorization = `${ALGORITHM} Credential=${signed.credential}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw fail(operation, key, name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : "the store could not be reached");
    }
    return res;
  };

  const check = async (operation: string, key: string, res: Response): Promise<never> => {
    const text = await res.text().catch(() => "");
    const code = s3ErrorCode(text);
    throw fail(operation, key, `HTTP ${res.status}${code ? ` ${code}` : ""}`);
  };

  return {
    name: "s3",
    async put(key, bytes, type) {
      const res = await send("PutObject", "PUT", key, bytes, type);
      if (!res.ok) return check("PutObject", key, res);
      await res.body?.cancel();
    },
    async get(key) {
      const res = await send("GetObject", "GET", key);
      if (res.status === 404) {
        // A missing key is null; a missing bucket (NoSuchBucket) is a configuration error.
        const code = s3ErrorCode(await res.text().catch(() => ""));
        if (code === undefined || code === "NoSuchKey") return null;
        throw fail("GetObject", key, `HTTP 404 ${code}`);
      }
      if (!res.ok) return check("GetObject", key, res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, type: (res.headers.get("content-type") ?? "").split(";")[0]!.trim() };
    },
    async delete(key) {
      // S3 answers 204 to a DELETE whether or not the key existed, so HEAD first to report it.
      const head = await send("HeadObject", "HEAD", key);
      await head.body?.cancel();
      if (head.status === 404) return false;
      if (!head.ok) return check("HeadObject", key, head);
      const res = await send("DeleteObject", "DELETE", key);
      if (!res.ok && res.status !== 404) return check("DeleteObject", key, res);
      await res.body?.cancel();
      return true;
    },
    async url(key, expiresIn) {
      const url = objectUrl(key);
      const date = new Date();
      const { stamp, day } = amzDate(date);
      url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
      url.searchParams.set("X-Amz-Credential", `${accessKeyId}/${day}/${region}/s3/aws4_request`);
      url.searchParams.set("X-Amz-Date", stamp);
      url.searchParams.set("X-Amz-Expires", String(expiresIn));
      if (sessionToken) url.searchParams.set("X-Amz-Security-Token", sessionToken);
      url.searchParams.set("X-Amz-SignedHeaders", "host");
      const signed = await signV4({ method: "GET", url, headers: {}, payloadHash: UNSIGNED, date, region, accessKeyId, secretAccessKey });
      // URLSearchParams encodes "/" in the credential as %2F, which is what S3 expects.
      return `${url.toString()}&X-Amz-Signature=${signed.signature}`;
    },
  };
}
