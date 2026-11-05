import assert from "node:assert/strict";
import { test } from "node:test";
import { createStaticHandler } from "react-router";
import { createAI, mockProvider } from "../../../src/ai/public.ts";
import { toReactRouterHandlers } from "../../../src/react-router.ts";
import { makeApp } from "../app/inferlo/app.server.ts";
import * as api from "../app/routes/api.ts";
import { classifyRoute } from "../app/routes/classify.ts";

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

/** React Router's data router with the example's routes, the way app/routes.ts declares them. */
function router(apiRoute: { loader: any; action: any }, classify = classifyRoute(createAI(mock()))) {
  const handler = createStaticHandler([
    { id: "api", path: "/api/*", loader: apiRoute.loader, action: apiRoute.action },
    { id: "classify", path: "/classify", loader: classify.loader, action: classify.action },
  ]);
  return async (url: string, init?: RequestInit): Promise<any> => {
    try {
      return await handler.queryRoute(new Request(url, init));
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };
}

test("the resource route serves the app under /api", async () => {
  assert.deepEqual(Object.keys(api).sort(), ["action", "loader"]);
  const request = router(api);
  const doc = await (await request("http://localhost:5173/api/openapi.json")).json();
  assert.ok(doc.paths["/summaries"].post);
  const anon = await request("http://localhost:5173/api/summaries", { method: "POST", body: JSON.stringify({ text: "x" }) });
  assert.equal(anon.status, 401);
  const invalid = await request("http://localhost:5173/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) });
  assert.equal(invalid.status, 422);
});

test("Inferlo routes call the AI and stream to the browser", async () => {
  const request = router(toReactRouterHandlers(makeApp(mock()), { prefix: "/api" }));
  const res = await request("http://localhost/api/summaries", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "Long text" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summary: "A short summary." });
  const stream = await request("http://localhost/api/chat?q=hi", { headers: signedIn });
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "A short summary.");
});

test("a page loader and action use the AI module with structured output", async () => {
  const request = router(api);
  assert.deepEqual(await request("http://localhost/classify"), { greeting: "A short summary." });
  const form = (text: string) => ({ method: "POST", body: new URLSearchParams({ text }) });
  assert.deepEqual(await request("http://localhost/classify", form("How do I export?")), { label: "question" });
  const empty = await request("http://localhost/classify", form(" "));
  assert.equal(empty.init?.status ?? empty.status, 400);
});
