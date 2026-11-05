import azureFunctions, { type HttpHandler } from "@azure/functions";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mockProvider } from "../src/ai/public.ts";
import { toAzureHandler } from "../src/azure.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";

// @azure/functions is bundled CommonJS, so its classes come from the default export in ES modules.
const { HttpRequest, HttpResponse } = azureFunctions;
type HttpRequest = InstanceType<typeof HttpRequest>;
type HttpResponse = InstanceType<typeof HttpResponse>;

const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

function makeApp() {
  const routes = {
    listItems: route.get("/items", { auth: "public", query: t.object({ q: t.array(t.string()).optional() }) }).handle(({ query, req }) => ({ q: query.q ?? null, url: req.url })),
    createItem: route.post("/items", { body: t.object({ name: t.string().min(1) }) }).handle(({ body, user, status }) => {
      status(201);
      return { name: body.name, ownerId: user.id };
    }),
    cookies: route.get("/cookies", { auth: "public" }).handle(({ req, header }) => {
      header("set-cookie", "a=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
      header("set-cookie", "b=2; Path=/admin; Domain=example.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
      header("set-cookie", "gone=; Max-Age=0; SameSite=None; Secure");
      return { cookie: req.headers.get("cookie") };
    }),
    limited: route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true })),
    image: route.get("/image.png", { auth: "public" }).handle(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), { headers: { "content-type": "image/png" } })),
    upload: route.post("/upload", { auth: "public" }).handle(async ({ req }) => ({ bytes: [...new Uint8Array(await req.arrayBuffer())] })),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({
    name: "azure-test",
    routes: [routes],
    auth: bearer((token) => users.get(token) ?? null),
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

/** A request shaped like the ones the Functions host passes to an HTTP trigger with route "{*path}". */
function azureRequest(method: string, path: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}): HttpRequest {
  return new HttpRequest({
    method,
    url: `http://localhost:7071${path}`,
    headers: { host: "my-func.azurewebsites.net", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9:51234", ...init.headers },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? { string: init.body } : { bytes: init.body },
  });
}

/** What the Functions host does with the handler's answer. */
async function send(handler: HttpHandler, request: HttpRequest): Promise<HttpResponse> {
  const result = await handler(request, {} as never);
  return result instanceof HttpResponse ? result : new HttpResponse(result as never);
}

describe("toAzureHandler", () => {
  const handler = toAzureHandler(makeApp(), { prefix: "/api" });

  test("is an Azure Functions HTTP handler that serves the app under the /api route prefix", async () => {
    const typed: HttpHandler = handler;
    const res = await send(typed, azureRequest("GET", "/api/items?q=a&q=b"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as { q: string[]; url: string };
    assert.deepEqual(body.q, ["a", "b"]);
    assert.equal(body.url, "https://my-func.azurewebsites.net/items?q=a&q=b", "the caller's scheme and host, without the prefix");
    const doc = (await (await send(handler, azureRequest("GET", "/api/openapi.json"))).json()) as { paths: Record<string, unknown> };
    assert.ok(doc.paths["/items"]);
  });

  test("bodies, auth and validation work as in any Inferlo app", async () => {
    const anon = await send(handler, azureRequest("POST", "/api/items", { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) }));
    assert.equal(anon.status, 401);
    assert.equal(((await anon.json()) as { error: { code: string } }).error.code, "IL3001");
    const signedIn = { "content-type": "application/json", authorization: "Bearer demo" };
    const invalid = await send(handler, azureRequest("POST", "/api/items", { headers: signedIn, body: JSON.stringify({ name: "" }) }));
    assert.equal(invalid.status, 422);
    const created = await send(handler, azureRequest("POST", "/api/items", { headers: signedIn, body: JSON.stringify({ name: "Lamp" }) }));
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: users.get("demo")!.id });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const upload = await send(handler, azureRequest("POST", "/api/upload", { headers: { "content-type": "application/octet-stream" }, body: bytes }));
    assert.deepEqual(await upload.json(), { bytes: [0, 1, 2, 250, 255] });
  });

  test("binary answers arrive unchanged", async () => {
    const res = await send(handler, azureRequest("GET", "/api/image.png"));
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  test("every Set-Cookie becomes its own cookie, and request cookies reach the app", async () => {
    const result = await handler(azureRequest("GET", "/api/cookies", { headers: { cookie: "session=abc; theme=dark" } }));
    assert.equal(result.headers["set-cookie"], undefined, "Azure would keep only one Set-Cookie header");
    assert.deepEqual(result.cookies, [
      { name: "a", value: "1", path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 },
      { name: "b", value: "2", path: "/admin", domain: "example.com", expires: new Date("2026-10-21T07:28:00Z") },
      { name: "gone", value: "", maxAge: 0, sameSite: "None", secure: true },
    ]);
    const res = new HttpResponse(result as never);
    assert.equal(res.cookies.length, 3);
    assert.deepEqual(await res.json(), { cookie: "session=abc; theme=dark" });
  });

  test("rate limits by IP use the address the Azure front end adds to X-Forwarded-For", async () => {
    const app = makeApp();
    const h = toAzureHandler(app, { prefix: "/api" });
    const first = await h(azureRequest("GET", "/api/limited", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.50:40000" } }));
    assert.equal(first.status, 200);
    // A client cannot escape the limit by sending its own X-Forwarded-For: the front end's entry is last.
    const spoofed = await h(azureRequest("GET", "/api/limited", { headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.50:40001" } }));
    assert.equal(spoofed.status, 429);
    const other = await h(azureRequest("GET", "/api/limited", { headers: { "x-forwarded-for": "[2001:db8::1]:40002" } }));
    assert.equal(other.status, 200);
  });

  test("AI streams are passed on as a stream", async () => {
    const result = await handler(azureRequest("GET", "/api/chat"));
    assert.equal(result.status, 200);
    assert.ok(result.body instanceof ReadableStream, "the body is a stream, so enableHttpStream sends it as it is written");
    const text = await new HttpResponse(result as never).text();
    const answer = [...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(answer, "Hello from AI.");
  });

  test("HEAD answers have no body, requests outside the prefix keep their path", async () => {
    const head = await handler(azureRequest("HEAD", "/api/items"));
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    const outside = await toAzureHandler(makeApp(), { prefix: "/api" })(azureRequest("GET", "/items"));
    assert.equal(outside.status, 200);
    const noPrefix = await toAzureHandler(makeApp())(azureRequest("GET", "/api/items"));
    assert.equal(noPrefix.status, 404);
  });

  test("invalid arguments and non-HTTP triggers raise IL5026", async () => {
    assert.throws(() => toAzureHandler({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5026");
    assert.throws(() => toAzureHandler(makeApp(), { prefix: "api" }), (e: unknown) => e instanceof InferloError && e.code === "IL5026");
    assert.throws(() => toAzureHandler(makeApp(), { route: "x" } as never), (e: unknown) => e instanceof InferloError && e.code === "IL5026");
    await assert.rejects(handler({ myQueueItem: "x" } as never), (e: unknown) => e instanceof InferloError && e.code === "IL5026");
  });
});
