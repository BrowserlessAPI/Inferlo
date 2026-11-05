import * as functions from "@google-cloud/functions-framework";
import { getTestServer } from "@google-cloud/functions-framework/testing";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { mockProvider } from "../src/ai/public.ts";
import { createApp, fromNodeRequest, route, t, toNodeHandler } from "../src/index.ts";

function makeApp() {
  const routes = {
    echo: route.post("/echo", { auth: "public" }).handle(async ({ req }) => ({ type: req.headers.get("content-type"), text: await req.text() })),
    item: route.post("/items", { auth: "public", body: t.object({ name: t.string().min(1) }) }).handle(({ body, status }) => (status(201), { name: body.name })),
    form: route.post("/form", { auth: "public" }).handle(async ({ req }) => Object.fromEntries(await req.formData())),
    upload: route.post("/upload", { auth: "public" }).handle(async ({ req }) => ({ bytes: [...new Uint8Array(await req.arrayBuffer())] })),
    cookies: route.get("/cookies", { auth: "public" }).handle(({ header }) => {
      header("set-cookie", "a=1; Path=/; HttpOnly");
      header("set-cookie", "b=2; Path=/");
      return { ok: true };
    }),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({
    name: "cloud-run-test",
    routes: [routes],
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
    logger: { info() {}, error() {} },
  });
}

describe("Google Cloud Run functions (Functions Framework) with toNodeHandler", () => {
  functions.http("inferloTest", toNodeHandler(makeApp()));
  functions.http("inferloPrefixed", toNodeHandler(makeApp(), { prefix: "/api" }));
  const servers = [getTestServer("inferloTest"), getTestServer("inferloPrefixed")];
  let base = "";
  let prefixed = "";
  before(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(servers[0]!.address() as AddressInfo).port}`;
    prefixed = `http://127.0.0.1:${(servers[1]!.address() as AddressInfo).port}`;
  });
  after(() => Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))));

  test("JSON bodies the Functions Framework already parsed reach the app byte for byte", async () => {
    const text = '{"id": 12345678901234567890, "id": 2}';
    const res = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
    assert.deepEqual(await res.json(), { type: "application/json", text });
    const created = await fetch(`${base}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp" });
    const invalid = await fetch(`${base}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(invalid.status, 422);
  });

  test("forms, text and binary bodies keep their content type and bytes", async () => {
    const form = await fetch(`${base}/form`, { method: "POST", body: new URLSearchParams({ name: "Ada", tags: "a b" }) });
    assert.deepEqual(await form.json(), { name: "Ada", tags: "a b" });
    const text = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "text/plain" }, body: "plain text" });
    assert.deepEqual(await text.json(), { type: "text/plain", text: "plain text" });
    const upload = await fetch(`${base}/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array([0, 1, 250, 255]) });
    assert.deepEqual(await upload.json(), { bytes: [0, 1, 250, 255] });
  });

  test("every Set-Cookie is sent, and AI answers stream", async () => {
    const res = await fetch(`${base}/cookies`);
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
    const chat = await fetch(`${base}/chat`);
    assert.match(chat.headers.get("content-type") ?? "", /text\/event-stream/);
    const answer = [...(await chat.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(answer, "Hello from AI.");
  });

  test("a prefix serves the app under a path", async () => {
    const res = await fetch(`${prefixed}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    assert.equal(res.status, 201);
  });
});

describe("fromNodeRequest with rawBody", () => {
  const nodeRequest = (extra: Record<string, unknown>) =>
    ({ method: "POST", url: "/x", headers: { host: "h", "content-type": "application/x-www-form-urlencoded", "content-length": "9" }, async *[Symbol.asyncIterator]() {}, ...extra }) as never;

  test("uses the exact bytes a host kept in rawBody, with their own content type", async () => {
    const request = fromNodeRequest(nodeRequest({ body: { a: "1", b: "2" }, rawBody: new TextEncoder().encode("a=1&b=2&c") }));
    assert.equal(request.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(await request.text(), "a=1&b=2&c");
  });

  test("without rawBody, a parsed body is still sent as JSON", async () => {
    const request = fromNodeRequest(nodeRequest({ body: { a: "1" } }));
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(await request.text(), '{"a":"1"}');
  });
});
