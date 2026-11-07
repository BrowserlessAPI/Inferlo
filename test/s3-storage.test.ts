// s3Storage(): AWS Signature Version 4 on Web Crypto, checked against AWS's published examples and AWS's own signer
// (@smithy/signature-v4, used by the AWS SDK), and the store run against a local S3 stand-in that refuses every
// request whose signature, payload hash or expiry AWS's signer would refuse (Node.js, Bun and Deno).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { createApp, InferloError, memoryStorage, route, s3Storage, t, type S3StorageOptions } from "../src/index.ts";
import { signV4, uriEncode } from "../src/s3-storage.ts";
import { createStorage } from "../src/storage.ts";
import { storageContract } from "./storage-contract.ts";

const quiet = { info() {}, error() {} };
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
// How the AWS SDK's S3 presigner calls the signer: the payload is not signed and only host is a signed header.
const UNSIGNED = { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };
const PRESIGN = { unsignableHeaders: new Set(["x-amz-content-sha256"]), unhoistableHeaders: new Set(["x-amz-content-sha256"]) };
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Signature Version 4", () => {
  test("matches AWS's published GET Object example (Authorization header)", async () => {
    const signed = await signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA, "x-amz-date": "20130524T000000Z" },
      payloadHash: EMPTY_SHA,
      date: new Date("2013-05-24T00:00:00Z"),
      region: "us-east-1",
      ...EXAMPLE,
    });
    assert.equal(signed.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
    assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  test("matches AWS's published presigned URL example", async () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    url.searchParams.set("X-Amz-Date", "20130524T000000Z");
    url.searchParams.set("X-Amz-Expires", "86400");
    url.searchParams.set("X-Amz-SignedHeaders", "host");
    const signed = await signV4({ method: "GET", url, headers: {}, payloadHash: "UNSIGNED-PAYLOAD", date: new Date("2013-05-24T00:00:00Z"), region: "us-east-1", ...EXAMPLE });
    assert.equal(signed.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  test("agrees with AWS's signer for PUT with a body, a session token and a non-default port", async () => {
    const body = new TextEncoder().encode("hello, s3");
    const payloadHash = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
    const date = new Date("2026-11-07T20:15:30Z");
    const credentials = { ...EXAMPLE, sessionToken: "FwoGZXIvYXdzE+token/with=chars" };
    const headers = { "content-type": "text/plain", "x-amz-content-sha256": payloadHash, "x-amz-date": "20261107T201530Z", "x-amz-security-token": credentials.sessionToken };
    const ours = await signV4({ method: "PUT", url: new URL("http://localhost:9000/acme-uploads/tenants/acme/a_b-c.d.txt"), headers, payloadHash, date, region: "eu-central-1", ...EXAMPLE });
    const aws = new SignatureV4({ service: "s3", region: "eu-central-1", credentials, sha256: Sha256, uriEscapePath: false });
    const theirs = await aws.sign(
      { method: "PUT", protocol: "http:", hostname: "localhost", port: 9000, path: "/acme-uploads/tenants/acme/a_b-c.d.txt", query: {}, headers: { ...headers, host: "localhost:9000" }, body },
      { signingDate: date },
    );
    assert.match(String(theirs.headers.authorization), new RegExp(`SignedHeaders=${ours.signedHeaders}, Signature=${ours.signature}$`));
  });

  test("encodes like RFC 3986", () => {
    assert.equal(uriEncode("a b+c/d~e*"), "a%20b%2Bc%2Fd~e%2A");
    assert.equal(uriEncode("a/b", true), "a/b");
    assert.equal(uriEncode("é"), "%C3%A9");
  });
});

/** A local S3 stand-in: path-style objects in memory, every request checked with AWS's own signer. */
interface FakeS3 {
  url: string;
  objects: Map<string, { bytes: Uint8Array; type: string }>;
  requests: string[];
  /** Shifts the stand-in's clock, to test expired links. */
  skewMs: number;
  close(): Promise<void>;
}

function xmlError(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function parseAmzDate(stamp: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) throw new Error(`bad x-amz-date ${stamp}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}

async function startFakeS3(options: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string }): Promise<FakeS3> {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const requests: string[] = [];
  const credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}) };
  const signer = new SignatureV4({ service: "s3", region: options.region, credentials, sha256: Sha256, uriEscapePath: false });
  const state = { skewMs: 0 };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body?: string | Uint8Array, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(typeof body === "string" ? { "content-type": "application/xml" } : {}), ...headers });
      res.end(body);
    };
    try {
      const body = await readBody(req);
      const url = new URL(req.url!, `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      const [, bucket, ...rest] = url.pathname.split("/");
      if (bucket !== options.bucket) return send(404, xmlError("NoSuchBucket"));
      const key = decodeURIComponent(rest.join("/"));
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const port = Number(url.port);

      if (query["X-Amz-Signature"]) {
        // Presigned URL: recompute it with AWS's signer at the same time and expiry.
        const date = parseAmzDate(query["X-Amz-Date"]!);
        const expiresIn = Number(query["X-Amz-Expires"]);
        const signature = query["X-Amz-Signature"];
        const plain: Record<string, string> = {};
        for (const [k, v] of Object.entries(query)) if (!k.startsWith("X-Amz-")) plain[k] = v;
        const expected = await signer.presign({ method: req.method!, protocol: "http:", hostname: url.hostname, port, path: url.pathname, query: plain, headers: { host: url.host, ...UNSIGNED } }, { signingDate: date, expiresIn, ...PRESIGN });
        if (expected.query?.["X-Amz-Signature"] !== signature) return send(403, xmlError("SignatureDoesNotMatch"));
        if (Date.now() + state.skewMs > date.getTime() + expiresIn * 1000) return send(403, xmlError("AccessDenied"));
        if (req.method !== "GET") return send(405, xmlError("MethodNotAllowed"));
      } else {
        const auth = String(req.headers.authorization ?? "");
        const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
        if (!m) return send(403, xmlError("AccessDenied"));
        const signedNames = m[2]!.split(";");
        const headers: Record<string, string> = {};
        for (const name of signedNames) headers[name] = String(req.headers[name] ?? "");
        const date = parseAmzDate(headers["x-amz-date"] ?? "");
        if (Math.abs(Date.now() - date.getTime()) > 15 * 60_000) return send(403, xmlError("RequestTimeTooSkewed"));
        const expected = await signer.sign({ method: req.method!, protocol: "http:", hostname: url.hostname, port, path: url.pathname, query, headers, body }, { signingDate: date });
        if (expected.headers.authorization !== auth) return send(403, xmlError("SignatureDoesNotMatch"));
        for (const name of ["host", "x-amz-content-sha256", "x-amz-date"]) if (!signedNames.includes(name)) return send(403, xmlError("AccessDenied"));
        if (options.sessionToken && !signedNames.includes("x-amz-security-token")) return send(403, xmlError("InvalidToken"));
        const actual = Buffer.from(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>)).toString("hex");
        if (headers["x-amz-content-sha256"] !== actual) return send(400, xmlError("XAmzContentSHA256Mismatch"));
      }

      const found = objects.get(key);
      switch (req.method) {
        case "PUT":
          objects.set(key, { bytes: body, type: String(req.headers["content-type"] ?? "binary/octet-stream") });
          return send(200, undefined, { etag: '"x"' });
        case "GET":
          if (!found) return send(404, xmlError("NoSuchKey"));
          return send(200, found.bytes, { "content-type": found.type, "content-length": String(found.bytes.byteLength) });
        case "HEAD":
          if (!found) return send(404);
          return send(200, undefined, { "content-type": found.type, "content-length": String(found.bytes.byteLength) });
        case "DELETE":
          objects.delete(key);
          return send(204);
        default:
          return send(405, xmlError("MethodNotAllowed"));
      }
    } catch (error) {
      send(500, xmlError("InternalError"));
      console.error(error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    objects,
    requests,
    get skewMs() {
      return state.skewMs;
    },
    set skewMs(value) {
      state.skewMs = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const CREDENTIALS = { accessKeyId: "INFERLOTESTKEY", secretAccessKey: "s3cr3t/Key+With=Chars-not-for-logs" };
let s3: FakeS3;
let s3WithToken: FakeS3;
const options = (extra: Partial<S3StorageOptions> = {}): S3StorageOptions => ({ bucket: "acme-uploads", region: "eu-central-1", endpoint: s3.url, ...CREDENTIALS, ...extra });

before(async () => {
  s3 = await startFakeS3({ bucket: "acme-uploads", region: "eu-central-1", ...CREDENTIALS });
  s3WithToken = await startFakeS3({ bucket: "temp-creds", region: "auto", ...CREDENTIALS, sessionToken: "session/token+value=" });
});
after(async () => {
  await s3.close();
  await s3WithToken.close();
});

storageContract("s3", async () => s3Storage(options()));

describe("s3Storage", () => {
  test("stores objects path-style in the bucket, with the media type", async () => {
    const storage = createStorage(s3Storage(options()));
    await storage.put("reports/2026-11.pdf", "%PDF-1.7", { type: "application/pdf" });
    assert.equal(s3.objects.get("reports/2026-11.pdf")?.type, "application/pdf");
    assert.ok(s3.requests.includes("PUT /acme-uploads/reports/2026-11.pdf"));
    const file = (await storage.get("reports/2026-11.pdf"))!;
    assert.equal(file.type, "application/pdf");
    assert.equal(await file.text(), "%PDF-1.7");
  });

  test("signs the session token of temporary credentials", async () => {
    const storage = createStorage(s3Storage({ bucket: "temp-creds", region: "auto", endpoint: s3WithToken.url, ...CREDENTIALS, sessionToken: "session/token+value=" }));
    await storage.put("a.txt", "a", { type: "text/plain" });
    assert.equal(await (await storage.get("a.txt"))!.text(), "a");
    const link = await storage.url("a.txt", { expiresIn: 60 });
    assert.match(link, /X-Amz-Security-Token=session%2Ftoken%2Bvalue%3D/);
    assert.equal(await (await fetch(link)).text(), "a");
    const without = createStorage(s3Storage({ bucket: "temp-creds", region: "auto", endpoint: s3WithToken.url, ...CREDENTIALS }));
    await assert.rejects(without.get("a.txt"), isCode("IL6049"));
  });

  test("storage.url() gives a signed link that downloads without credentials until it expires", async () => {
    const storage = createStorage(s3Storage(options()));
    await storage.put("shared/q3.csv", "a,b\n1,2\n", { type: "text/csv" });
    const link = await storage.url("shared/q3.csv", { expiresIn: 300 });
    assert.ok(link.startsWith(`${s3.url}/acme-uploads/shared/q3.csv?`));
    assert.match(link, /X-Amz-Credential=INFERLOTESTKEY%2F\d{8}%2Feu-central-1%2Fs3%2Faws4_request/);
    assert.match(link, /X-Amz-Expires=300/);
    assert.ok(!link.includes(CREDENTIALS.secretAccessKey) && !link.includes(encodeURIComponent(CREDENTIALS.secretAccessKey)));
    const res = await fetch(link);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv");
    assert.equal(await res.text(), "a,b\n1,2\n");
    assert.equal((await fetch(link.replace("q3.csv", "q4.csv"))).status, 403, "the link is for one key only");
    assert.equal((await fetch(link, { method: "DELETE" })).status, 403, "the link only reads");
    s3.skewMs = 301_000;
    try {
      assert.equal((await fetch(link)).status, 403, "expired");
    } finally {
      s3.skewMs = 0;
    }
  });

  test("storage.url() on AWS S3 uses the virtual-hosted bucket address and AWS's signature", async () => {
    const store = s3Storage({ bucket: "acme-uploads", region: "eu-central-1", ...EXAMPLE });
    const link = new URL(await createStorage(store).url("avatars/42.png", { expiresIn: 900 }));
    assert.equal(link.origin, "https://acme-uploads.s3.eu-central-1.amazonaws.com");
    assert.equal(link.pathname, "/avatars/42.png");
    const query = Object.fromEntries(link.searchParams);
    const aws = new SignatureV4({ service: "s3", region: "eu-central-1", credentials: EXAMPLE, sha256: Sha256, uriEscapePath: false });
    const expected = await aws.presign(
      { method: "GET", protocol: "https:", hostname: link.hostname, path: link.pathname, query: {}, headers: { host: link.host, ...UNSIGNED } },
      { signingDate: parseAmzDate(query["X-Amz-Date"]!), expiresIn: 900, ...PRESIGN },
    );
    assert.equal(query["X-Amz-Signature"], expected.query?.["X-Amz-Signature"]);
    const pathStyle = new URL(await createStorage(s3Storage({ bucket: "acme.uploads", region: "us-east-1", pathStyle: true, ...EXAMPLE })).url("a.txt", { expiresIn: 1 }));
    assert.equal(pathStyle.origin + pathStyle.pathname, "https://s3.us-east-1.amazonaws.com/acme.uploads/a.txt");
  });

  test("expiresIn is required and at most seven days (IL6039); stores without signed URLs throw IL6050", async () => {
    const storage = createStorage(s3Storage(options()));
    for (const expiresIn of [undefined, 0, -1, 1.5, 604_801, "60"]) {
      await assert.rejects(storage.url("a.txt", { expiresIn } as never), isCode("IL6039"));
    }
    await assert.rejects(storage.url("../a.txt", { expiresIn: 60 }), isCode("IL6039"));
    await assert.rejects(createStorage(memoryStorage()).url("a.txt", { expiresIn: 60 }), (e: unknown) => isCode("IL6050")(e) && (e as InferloError).status === 500);
  });

  test("S3 errors are 502 IL6049 naming S3's code, never the secret key", async () => {
    const wrong = createStorage(s3Storage(options({ secretAccessKey: "wrong-secret-value" })));
    await assert.rejects(wrong.put("a.txt", "x"), (e: unknown) => {
      assert.ok(isCode("IL6049")(e));
      const error = e as InferloError;
      assert.equal(error.status, 502);
      assert.match(error.message, /PutObject of "a.txt" in bucket "acme-uploads" failed: HTTP 403 SignatureDoesNotMatch/);
      assert.ok(!JSON.stringify({ message: error.message, fix: error.fix }).includes("wrong-secret-value"));
      return true;
    });
    const otherBucket = createStorage(s3Storage(options({ bucket: "missing-bucket" })));
    await assert.rejects(otherBucket.get("a.txt"), /HTTP 404 NoSuchBucket/, "a missing bucket is an error, not a missing file");
  });

  test("an unreachable store is 502 IL6049", async () => {
    const closed = await startFakeS3({ bucket: "acme-uploads", region: "eu-central-1", ...CREDENTIALS });
    await closed.close();
    const storage = createStorage(s3Storage(options({ endpoint: closed.url, timeoutMs: 2000 })));
    await assert.rejects(storage.get("a.txt"), (e: unknown) => isCode("IL6049")(e) && /could not be reached|no answer/.test((e as Error).message));
  });

  test("checks its options at startup (IL6048)", () => {
    const bad: unknown[] = [
      undefined,
      { ...options(), bucket: "Acme_Uploads" },
      { ...options(), bucket: "ab" },
      { ...options(), region: "" },
      { ...options(), accessKeyId: "" },
      { ...options(), secretAccessKey: "" },
      { ...options(), sessionToken: "" },
      { ...options(), endpoint: "http://minio.internal:9000" },
      { ...options(), endpoint: "https://r2.example.com/acme-uploads" },
      { ...options(), endpoint: "not a url" },
      { ...options(), timeoutMs: 10 },
      { ...options(), pathStyle: "yes" },
      { ...options(), bucketName: "acme" },
      { bucket: "acme.uploads", region: "us-east-1", ...CREDENTIALS },
    ];
    for (const value of bad) assert.throws(() => s3Storage(value as never), isCode("IL6048"), JSON.stringify(value));
    assert.doesNotThrow(() => s3Storage({ ...options(), endpoint: "https://0123.r2.cloudflarestorage.com", region: "auto" }));
    assert.doesNotThrow(() => s3Storage({ ...options(), endpoint: "http://127.0.0.1:9000" }));
  });

  test("createApp({ storage: s3Storage() }) in routes, with describe showing s3", async () => {
    const upload = route.put("/files/:name", { auth: "public", params: t.object({ name: t.string().regex(/^[a-z0-9-]+\.txt$/) }), body: t.object({ file: t.file({ maxBytes: 1000 }) }) }).handle(async ({ params, body, storage }) => storage.put(`files/${params.name}`, body.file));
    const download = route.get("/files/:name", { auth: "public", params: t.object({ name: t.string() }) }).handle(async ({ params, storage }) => {
      return new Response(null, { status: 303, headers: { location: await storage.url(`files/${params.name}`, { expiresIn: 60 }) } });
    });
    const app = createApp({ routes: [{ upload, download }], storage: s3Storage(options()), logger: quiet });
    assert.equal(app.describe().storage, "s3");
    const form = new FormData();
    form.append("file", new Blob(["hi"], { type: "text/plain" }), "hi.txt");
    const res = await app.request("/files/hello.txt", { method: "PUT", body: form });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key: "files/hello.txt", size: 2, type: "text/plain" });
    const redirect = await app.request("/files/hello.txt");
    assert.equal(redirect.status, 303);
    assert.equal(await (await fetch(redirect.headers.get("location")!)).text(), "hi");
  });
});
