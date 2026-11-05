import azureFunctions from "@azure/functions";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handler } from "../src/functions/inferlo.ts";

const { HttpRequest, HttpResponse } = azureFunctions;
const request = (method: string, path: string, body?: string) =>
  new HttpRequest({ method, url: `https://notes.azurewebsites.net${path}`, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : { string: body } });

test("the Azure function serves the Inferlo app under /api", async () => {
  const source = readFileSync(new URL("../src/functions/inferlo.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/azure/, "uses the Azure Functions entry point");
  assert.match(source, /enableHttpStream:\s*true/, "HTTP streaming is enabled");
  assert.match(source, /\{\*path\}/, "one function for every path");
  const health = new HttpResponse(await handler(request("GET", "/api/health"), {} as never));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const doc = (await new HttpResponse(await handler(request("GET", "/api/openapi.json"), {} as never)).json()) as { paths: Record<string, unknown> };
  assert.ok(doc.paths["/notes"], "OpenAPI of the app");
  const post = new HttpResponse(await handler(request("POST", "/api/notes", JSON.stringify({ title: "x" })), {} as never));
  assert.equal(post.status, 401, "POST /notes needs sign-in");
  assert.equal(((await post.json()) as { error: { code: string } }).error.code, "IL3001");
});
