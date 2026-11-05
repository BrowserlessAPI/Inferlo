import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { toLambdaHandler, type AwsLambdaGlobal, type LambdaHttpEventV2 } from "../../../src/lambda.ts";
import { makeApp } from "../src/app.ts";
import { handler } from "../src/handler.ts";

const mock = () => ({ providers: { anthropic: mockProvider({ respond: () => "A short summary." }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

function event(method: string, rawPath: string, extra: Partial<LambdaHttpEventV2> = {}): LambdaHttpEventV2 {
  return {
    version: "2.0",
    rawPath,
    rawQueryString: "",
    headers: { host: "api.example.com", "x-forwarded-proto": "https" },
    requestContext: { domainName: "api.example.com", http: { method, sourceIp: "203.0.113.9" } },
    isBase64Encoded: false,
    ...extra,
  };
}

test("the HTTP API handler serves the app: OpenAPI, auth and validation", async () => {
  const doc = await handler(event("GET", "/openapi.json"));
  assert.ok(JSON.parse(doc.body).paths["/summaries"].post);
  assert.equal((await handler(event("GET", "/status"))).statusCode, 200);
  const anon = await handler(event("POST", "/summaries", { body: JSON.stringify({ text: "x" }), headers: { "content-type": "application/json" } }));
  assert.equal(anon.statusCode, 401);
  const invalid = await handler(event("POST", "/summaries", { body: JSON.stringify({ text: "" }), headers: signedIn }));
  assert.equal(invalid.statusCode, 422);
});

test("routes call the AI, and the streaming handler streams its answer", async () => {
  const app = makeApp(mock());
  const res = await toLambdaHandler(app)(event("POST", "/summaries", { body: JSON.stringify({ text: "Long text" }), headers: signedIn }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { summary: "A short summary." });

  const chunks: Uint8Array[] = [];
  let statusCode = 0;
  const awslambda: AwsLambdaGlobal = {
    streamifyResponse: (fn) => fn,
    HttpResponseStream: {
      from(stream, metadata) {
        statusCode = metadata.statusCode;
        return stream;
      },
    },
  };
  const stream = toLambdaHandler(app, { streaming: true, awslambda });
  await stream(event("GET", "/chat", { rawQueryString: "q=hi", headers: signedIn }), { write: (c) => (chunks.push(c), true), end() {} });
  assert.equal(statusCode, 200);
  const text = [...Buffer.concat(chunks).toString("utf8").matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});
