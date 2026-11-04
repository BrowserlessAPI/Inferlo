import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";

const quiet = { info: () => {}, error: () => {} };
const DOCS = "https://example.com/docs/tickets-v2";

const listV1 = route
  .get("/v1/tickets", { auth: "public", summary: "List tickets", tool: true, deprecated: { since: "2026-11-01", sunset: "2027-06-30", link: DOCS } })
  .handle(() => [{ id: 1 }]);
const createV1 = route
  .post("/v1/tickets", { body: t.object({ title: t.string().max(100) }), deprecated: { since: new Date("2026-11-01T12:00:00Z") } })
  .handle(({ body }) => body);
const oldExport = route.get("/v1/export", { auth: "public", deprecated: true, tool: { description: "Export tickets as CSV" } }).handle(() => new Response("id\n1", { headers: { "content-type": "text/csv" } }));
const listV2 = route.get("/v2/tickets", { auth: "public", tool: true }).handle(() => [{ id: 1 }]);

const app = createApp({
  routes: [{ listV1, createV1, oldExport, listV2 }],
  auth: bearer((token) => (token === "good" ? { id: "u1" } : null)),
  logger: quiet,
});

describe("deprecated routes", () => {
  test("send Deprecation (RFC 9745), Sunset (RFC 8594) and Link rel=deprecation headers", async () => {
    const res = await app.request("/v1/tickets");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("deprecation"), `@${Date.UTC(2026, 10, 1) / 1000}`);
    assert.equal(res.headers.get("sunset"), "Wed, 30 Jun 2027 00:00:00 GMT");
    assert.equal(res.headers.get("link"), `<${DOCS}>; rel="deprecation"; type="text/html"`);
    assert.deepEqual(await res.json(), [{ id: 1 }]);
  });

  test("errors of a deprecated route carry the headers too, and other routes have none", async () => {
    const unauthorized = await app.request("/v1/tickets", { method: "POST", json: { title: "x" } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("deprecation"), `@${Date.UTC(2026, 10, 1, 12) / 1000}`);
    assert.equal(unauthorized.headers.get("sunset"), null);
    const invalid = await app.request("/v1/tickets", { method: "POST", json: { title: 1 }, headers: { authorization: "Bearer good" } });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.headers.get("deprecation"));
    const current = await app.request("/v2/tickets");
    assert.equal(current.headers.get("deprecation"), null);
    assert.equal(current.headers.get("link"), null);
  });

  test("deprecated: true marks the route without sending headers, also for handlers that return a Response", async () => {
    const res = await app.request("/v1/export");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv");
    assert.equal(res.headers.get("deprecation"), null);
  });

  test("OpenAPI, describe() and MCP tool descriptions show the deprecation", async () => {
    const doc = app.openapi() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    assert.equal(doc.paths["/v1/tickets"]!.get!.deprecated, true);
    assert.deepEqual(doc.paths["/v1/tickets"]!.get!["x-inferlo-deprecation"], { since: "2026-11-01", sunset: "2027-06-30", link: DOCS });
    assert.deepEqual(doc.paths["/v1/tickets"]!.post!["x-inferlo-deprecation"], { since: "2026-11-01T12:00:00.000Z" });
    assert.equal(doc.paths["/v1/export"]!.get!.deprecated, true);
    assert.equal(doc.paths["/v1/export"]!.get!["x-inferlo-deprecation"], undefined);
    assert.equal(doc.paths["/v2/tickets"]!.get!.deprecated, undefined);

    const routes = app.describe().routes;
    assert.deepEqual(routes.find((r) => r.path === "/v1/tickets" && r.method === "GET")!.deprecated, { since: "2026-11-01", sunset: "2027-06-30", link: DOCS });
    assert.equal(routes.find((r) => r.path === "/v1/export")!.deprecated, true);
    assert.equal(routes.find((r) => r.path === "/v2/tickets")!.deprecated, undefined);

    const res = await app.request("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tools = (await res.json()).result.tools as { name: string; description: string }[];
    assert.equal(tools.find((x) => x.name === "listV1")!.description, "List tickets (Deprecated, stops working on 2027-06-30.)");
    assert.equal(tools.find((x) => x.name === "oldExport")!.description, "Export tickets as CSV (Deprecated.)");
    assert.equal(tools.find((x) => x.name === "listV2")!.description, "GET /v2/tickets");
  });

  test("invalid options raise IL6021 when the app is created", () => {
    const bad = (deprecated: unknown) =>
      assert.throws(
        () => createApp({ routes: [route.get("/old", { auth: "public", deprecated: deprecated as never }).handle(() => ({}))], logger: quiet }),
        (e: unknown) => e instanceof InferloError && e.code === "IL6021" && e.message.includes("GET /old"),
      );
    bad("yes");
    bad({ since: "next week" });
    bad({ since: "01/11/2026" });
    bad({ sunset: new Date("nope") });
    bad({ since: "2027-01-01", sunset: "2026-01-01" });
    bad({ link: "javascript:alert(1)" });
    bad({ link: "https://example.com/a b" });
    bad({ link: 'https://example.com/"><' });
    bad({ until: "2027-01-01" });
    createApp({ routes: [route.get("/old", { auth: "public", deprecated: false }).handle(() => ({}))], logger: quiet });
  });
});
