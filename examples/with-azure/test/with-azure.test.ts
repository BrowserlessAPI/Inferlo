import azureFunctions from "@azure/functions";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockProvider } from "../../../src/ai/public.ts";
import { toAzureHandler } from "../../../src/azure.ts";
import { makeApp } from "../src/app.ts";
import { handler } from "../src/functions/inferlo.ts";

const { HttpRequest, HttpResponse } = azureFunctions;
const mock = () => ({ providers: { anthropic: mockProvider({ respond: () => "A short summary." }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

function request(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new HttpRequest({ method, url: `https://with-azure.azurewebsites.net${path}`, headers, body: body === undefined ? undefined : { string: body } });
}

test("the function serves the app under /api: OpenAPI, auth and validation", async () => {
  const doc = (await new HttpResponse(await handler(request("GET", "/api/openapi.json"))).json()) as { paths: Record<string, { post?: unknown }> };
  assert.ok(doc.paths["/summaries"]?.post);
  assert.equal((await handler(request("GET", "/api/status"))).status, 200);
  assert.equal((await handler(request("POST", "/api/summaries", { "content-type": "application/json" }, JSON.stringify({ text: "x" })))).status, 401);
  assert.equal((await handler(request("POST", "/api/summaries", signedIn, JSON.stringify({ text: "" })))).status, 422);
});

test("routes call the AI, and AI answers stream", async () => {
  const h = toAzureHandler(makeApp(mock()), { prefix: "/api" });
  const res = new HttpResponse(await h(request("POST", "/api/summaries", signedIn, JSON.stringify({ text: "Long text" }))));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await h(request("GET", "/api/chat?q=hi", signedIn));
  assert.ok(stream.body instanceof ReadableStream);
  const text = await new HttpResponse(stream).text();
  const answer = [...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(answer, "A short summary.");
});
