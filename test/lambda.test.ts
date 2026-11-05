import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mockProvider } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { toLambdaHandler, type AwsLambdaGlobal, type LambdaHttpEventV1, type LambdaHttpEventV2, type LambdaResponseStream, type LambdaResultV1, type LambdaResultV2 } from "../src/lambda.ts";

const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

function makeApp() {
  const routes = {
    listItems: route.get("/items", { auth: "public", query: t.object({ q: t.array(t.string()).optional(), page: t.int().optional() }) }).handle(({ query }) => ({ q: query.q ?? null, page: query.page ?? null })),
    createItem: route.post("/items", { body: t.object({ name: t.string().min(1) }) }).handle(({ body, user, status }) => {
      status(201);
      return { name: body.name, ownerId: user.id };
    }),
    whoami: route.get("/cookies", { auth: "public" }).handle(({ req, header }) => {
      header("set-cookie", "a=1; Path=/; HttpOnly");
      header("set-cookie", "b=2; Path=/");
      return { cookie: req.headers.get("cookie") };
    }),
    limited: route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true })),
    image: route.get("/image.png", { auth: "public" }).handle(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), { headers: { "content-type": "image/png" } })),
    upload: route.post("/upload", { auth: "public" }).handle(async ({ req }) => ({ bytes: [...new Uint8Array(await req.arrayBuffer())] })),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({
    name: "lambda-test",
    routes: [routes],
    auth: bearer((token) => users.get(token) ?? null),
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

/** A function URL / HTTP API event (payload 2.0), shaped like the ones AWS sends. */
function v2(method: string, rawPath: string, extra: Partial<LambdaHttpEventV2> = {}): LambdaHttpEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: { host: "abc123.lambda-url.us-east-1.on.aws", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", "user-agent": "curl/8.5.0" },
    requestContext: {
      accountId: "123456789012",
      apiId: "abc123",
      domainName: "abc123.lambda-url.us-east-1.on.aws",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "curl/8.5.0" },
      requestId: "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
      stage: "$default",
      time: "05/Nov/2026:12:00:00 +0000",
      timeEpoch: 1793966400000,
    },
    isBase64Encoded: false,
    ...extra,
  } as LambdaHttpEventV2;
}

/** A REST API event (payload 1.0), shaped like the ones API Gateway sends with a Lambda proxy integration. */
function v1(method: string, path: string, extra: Partial<LambdaHttpEventV1> = {}): LambdaHttpEventV1 {
  return {
    version: "1.0",
    resource: "/{proxy+}",
    path,
    httpMethod: method,
    headers: { Host: "abc123.execute-api.us-east-1.amazonaws.com", "X-Forwarded-Proto": "https" },
    multiValueHeaders: { Host: ["abc123.execute-api.us-east-1.amazonaws.com"], "X-Forwarded-Proto": ["https"] },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: { proxy: path.slice(1) },
    stageVariables: null,
    requestContext: { domainName: "abc123.execute-api.us-east-1.amazonaws.com", identity: { sourceIp: "198.51.100.7" }, stage: "prod", path: `/prod${path}` },
    body: null,
    isBase64Encoded: false,
    ...extra,
  } as LambdaHttpEventV1;
}

describe("toLambdaHandler", () => {
  const handler = toLambdaHandler(makeApp());

  test("answers function URL and HTTP API events (payload 2.0) in their response format", async () => {
    const res = (await handler(v2("GET", "/items", { rawQueryString: "q=a&q=b&page=2" }))) as LambdaResultV2;
    assert.equal(res.statusCode, 200);
    assert.equal(res.isBase64Encoded, false);
    assert.match(res.headers["content-type"]!, /application\/json/);
    assert.ok(res.headers["x-request-id"]);
    assert.deepEqual(JSON.parse(res.body), { q: ["a", "b"], page: 2 });
    assert.equal("multiValueHeaders" in res, false);
  });

  test("answers REST API events (payload 1.0) with multi-value query strings and headers", async () => {
    const res = (await handler(v1("GET", "/items", { multiValueQueryStringParameters: { q: ["a b", "c"] }, queryStringParameters: { q: "c" } }))) as LambdaResultV1;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { q: ["a b", "c"], page: null });
    assert.deepEqual(res.multiValueHeaders, {});
    const single = (await handler(v1("GET", "/items", { multiValueHeaders: null, queryStringParameters: { page: "3" } }))) as LambdaResultV1;
    assert.deepEqual(JSON.parse(single.body), { q: null, page: 3 });
  });

  test("runs auth and validation, and reads JSON bodies, also base64 encoded", async () => {
    const anon = await handler(v2("POST", "/items", { body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" } }));
    assert.equal(anon.statusCode, 401);
    assert.equal(JSON.parse(anon.body).error.code, "IL3001");
    const headers = { "content-type": "application/json", authorization: "Bearer demo" };
    const invalid = await handler(v2("POST", "/items", { body: JSON.stringify({ name: "" }), headers }));
    assert.equal(invalid.statusCode, 422);
    const created = await handler(v2("POST", "/items", { body: btoa(JSON.stringify({ name: "Lamp" })), isBase64Encoded: true, headers }));
    assert.equal(created.statusCode, 201);
    assert.deepEqual(JSON.parse(created.body), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
    const rest = await handler(v1("POST", "/items", { body: JSON.stringify({ name: "Desk" }), multiValueHeaders: { "Content-Type": ["application/json"], Authorization: ["Bearer demo"] } }));
    assert.equal(rest.statusCode, 201);
  });

  test("passes cookies in and returns each Set-Cookie separately", async () => {
    const res = (await handler(v2("GET", "/cookies", { cookies: ["session=abc", "theme=dark"] }))) as LambdaResultV2;
    assert.deepEqual(JSON.parse(res.body), { cookie: "session=abc; theme=dark" });
    assert.deepEqual(res.cookies, ["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
    assert.equal(res.headers["set-cookie"], undefined);
    const rest = (await handler(v1("GET", "/cookies", { multiValueHeaders: { Cookie: ["session=abc"] } }))) as LambdaResultV1;
    assert.deepEqual(JSON.parse(rest.body), { cookie: "session=abc" });
    assert.deepEqual(rest.multiValueHeaders["set-cookie"], ["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
    assert.equal(rest.headers["set-cookie"], undefined);
  });

  test("uses the caller's source IP for rate limits by IP", async () => {
    const limited = toLambdaHandler(makeApp());
    const from = (ip: string) => v2("GET", "/limited", { requestContext: { domainName: "x.on.aws", http: { method: "GET", sourceIp: ip } } });
    assert.equal((await limited(from("203.0.113.1"))).statusCode, 200);
    assert.equal((await limited(from("203.0.113.2"))).statusCode, 200);
    const again = await limited(from("203.0.113.1"));
    assert.equal(again.statusCode, 429);
    const rest = (ip: string) => v1("GET", "/limited", { requestContext: { identity: { sourceIp: ip } } });
    assert.equal((await limited(rest("198.51.100.1"))).statusCode, 200);
    assert.equal((await limited(rest("198.51.100.1"))).statusCode, 429);
  });

  test("base64 encodes binary bodies both ways", async () => {
    const image = await handler(v2("GET", "/image.png"));
    assert.equal(image.isBase64Encoded, true);
    assert.deepEqual([...Uint8Array.from(atob(image.body), (c) => c.charCodeAt(0))], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const upload = await handler(v2("POST", "/upload", { body: btoa(String.fromCharCode(0, 1, 254, 255)), isBase64Encoded: true, headers: { "content-type": "application/octet-stream" } }));
    assert.deepEqual(JSON.parse(upload.body), { bytes: [0, 1, 254, 255] });
  });

  test("serves OpenAPI, 404s and HEAD requests", async () => {
    const doc = await handler(v2("GET", "/openapi.json"));
    assert.ok(JSON.parse(doc.body).paths["/items"]);
    const missing = await handler(v2("GET", "/nope"));
    assert.equal(missing.statusCode, 404);
    const head = await handler(v2("HEAD", "/items"));
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
  });

  test("removes the prefix, such as an HTTP API stage, and keeps other paths", async () => {
    const staged = toLambdaHandler(makeApp(), { prefix: "/prod/" });
    const res = await staged(v2("GET", "/prod/items", { rawQueryString: "page=1" }));
    assert.deepEqual(JSON.parse(res.body), { q: null, page: 1 });
    assert.equal((await staged(v2("GET", "/prod"))).statusCode, 404);
    assert.equal((await staged(v2("GET", "/items"))).statusCode, 200);
    assert.equal((await staged(v2("GET", "/production/items"))).statusCode, 404);
  });

  test("streams answers, AI streams included, with Lambda response streaming", async () => {
    const written: { metadata?: unknown; chunks: Uint8Array[]; ended: boolean } = { chunks: [], ended: false };
    const awslambda: AwsLambdaGlobal = {
      streamifyResponse: (fn) => fn,
      HttpResponseStream: {
        from(stream, metadata) {
          written.metadata = metadata;
          return stream;
        },
      },
    };
    const stream: LambdaResponseStream = {
      write(chunk) {
        written.chunks.push(chunk);
        return true;
      },
      end() {
        written.ended = true;
      },
    };
    const streaming = toLambdaHandler(makeApp(), { streaming: true, awslambda });
    await streaming(v2("GET", "/chat"), stream);
    assert.equal(written.ended, true);
    const meta = written.metadata as { statusCode: number; headers: Record<string, string> };
    assert.equal(meta.statusCode, 200);
    assert.match(meta.headers["content-type"]!, /text\/event-stream/);
    const text = Buffer.concat(written.chunks).toString("utf8");
    const answer = [...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(answer, "Hello from AI.");

    written.chunks = [];
    await streaming(v2("GET", "/cookies"), stream);
    assert.deepEqual((written.metadata as { cookies: string[] }).cookies, ["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
  });

  test("waits for the stream to drain when Lambda asks for backpressure", async () => {
    let drains = 0;
    const listeners: Array<() => void> = [];
    const stream: LambdaResponseStream = {
      write: () => false,
      end() {},
      once(_event, listener) {
        drains++;
        listeners.push(listener as () => void);
        queueMicrotask(() => listeners.shift()?.());
      },
    };
    const awslambda: AwsLambdaGlobal = { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
    await toLambdaHandler(makeApp(), { streaming: true, awslambda })(v2("GET", "/items"), stream);
    assert.ok(drains >= 1);
  });

  test("invalid arguments and events raise IL5024", async () => {
    const code = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5024");
    code(() => toLambdaHandler({} as never));
    code(() => toLambdaHandler(makeApp(), { prefix: "api" }));
    code(() => toLambdaHandler(makeApp(), { streaming: "yes" as never }));
    code(() => toLambdaHandler(makeApp(), null as never));
    code(() => toLambdaHandler(makeApp(), { streaming: true }));
    await assert.rejects(handler({ Records: [] } as never), (e: unknown) => e instanceof InferloError && e.code === "IL5024");
  });
});
