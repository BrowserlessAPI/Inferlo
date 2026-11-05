import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as lambda from "../src/lambda.ts";

const httpApi = (method: string, rawPath: string, body?: string) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath,
  rawQueryString: "",
  headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", "content-type": "application/json" },
  requestContext: { domainName: "abc123.execute-api.us-east-1.amazonaws.com", http: { method, path: rawPath, sourceIp: "203.0.113.9" }, stage: "$default" },
  body,
  isBase64Encoded: false,
});

const restApi = (method: string, path: string) => ({
  resource: "/{proxy+}",
  path,
  httpMethod: method,
  headers: { Host: "abc123.execute-api.us-east-1.amazonaws.com" },
  multiValueHeaders: { Host: ["abc123.execute-api.us-east-1.amazonaws.com"] },
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  requestContext: { identity: { sourceIp: "198.51.100.7" }, stage: "prod" },
  body: null,
  isBase64Encoded: false,
});

test("the Lambda handler runs the Inferlo app for API Gateway events", async () => {
  const source = readFileSync(new URL("../src/lambda.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/lambda/, "uses the Lambda entry point");
  const handler = (lambda as Record<string, any>).handler;
  assert.equal(typeof handler, "function", "exports handler");
  const health = await handler(httpApi("GET", "/health"));
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });
  const doc = await handler(restApi("GET", "/openapi.json"));
  assert.equal(doc.statusCode, 200);
  assert.ok(JSON.parse(doc.body).paths["/notes"], "OpenAPI of the app");
  const post = await handler(httpApi("POST", "/notes", JSON.stringify({ title: "x" })));
  assert.equal(post.statusCode, 401, "POST /notes needs sign-in");
  assert.equal(JSON.parse(post.body).error.code, "IL3001");
});
