import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiVersion, bearer, createApp, InferloError, module, route, t, toNodeHandler } from "../src/index.ts";

const quiet = { info: () => {}, error: () => {} };

// v1 and v2 differ for the ticket list; getTicket did not change and is in both versions.
const v1 = {
  listTickets: route.get("/tickets", { auth: "public", tool: true, summary: "List tickets" }).handle(() => [{ id: 1, title: "Old shape" }]),
};
const shared = {
  getTicket: route.get("/tickets/:id", { auth: "public", params: t.object({ id: t.int() }), tool: true }).handle(({ params }) => ({ id: params.id })),
};
const v2 = {
  listTickets: route.get("/tickets", { auth: "public", tool: true, summary: "List tickets" }).handle(() => ({ items: [{ id: 1, title: "New shape" }] })),
  root: route.get("/", { auth: "public" }).handle(() => ({ version: 2 })),
};
const login = route.post("/login", { auth: "public" }).handle(() => ({ token: "t" }));

const DOCS = "https://example.com/docs/v2-migration";

function makeApp() {
  return createApp({
    name: "versioned",
    routes: [
      apiVersion("v1", [v1, shared], { deprecated: { since: "2026-11-01", sunset: "2027-06-30", link: DOCS } }),
      apiVersion("v2", [v2, shared]),
      { login },
    ],
    auth: bearer(() => null),
    logger: quiet,
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof InferloError, `expected an InferloError, got ${String(e)}`);
    return e.code;
  }
  assert.fail("expected an error");
}

describe("apiVersion()", () => {
  test("routes are served under their version prefix, and a shared route is in both", async () => {
    const app = makeApp();
    assert.deepEqual(await (await app.request("/v1/tickets")).json(), [{ id: 1, title: "Old shape" }]);
    assert.deepEqual(await (await app.request("/v2/tickets")).json(), { items: [{ id: 1, title: "New shape" }] });
    assert.deepEqual(await (await app.request("/v1/tickets/7")).json(), { id: 7 });
    assert.deepEqual(await (await app.request("/v2/tickets/7")).json(), { id: 7 });
    assert.deepEqual(await (await app.request("/v2")).json(), { version: 2 });
    assert.equal((await app.request("/tickets")).status, 404);
    assert.equal((await app.request("/login", { method: "POST" })).status, 200);
  });

  test("routes are named <version>_<export> and carry their version", () => {
    const app = makeApp();
    const names = app.routes.map((r) => `${r.method} ${r.path} ${r.name} ${r.version ?? "-"}`);
    assert.deepEqual(names, [
      "GET /v1/tickets v1_listTickets v1",
      "GET /v1/tickets/:id v1_getTicket v1",
      "GET /v2/tickets v2_listTickets v2",
      "GET /v2 v2_root v2",
      "GET /v2/tickets/:id v2_getTicket v2",
      "POST /login login -",
    ]);
  });

  test("a version's deprecated option sends the headers on all its routes", async () => {
    const app = makeApp();
    const old = await app.request("/v1/tickets/1");
    assert.equal(old.headers.get("deprecation"), `@${Date.UTC(2026, 10, 1) / 1000}`);
    assert.equal(old.headers.get("sunset"), "Wed, 30 Jun 2027 00:00:00 GMT");
    assert.equal(old.headers.get("link"), `<${DOCS}>; rel="deprecation"; type="text/html"`);
    assert.equal((await app.request("/v2/tickets/1")).headers.get("deprecation"), null);
    const own = createApp({
      routes: [apiVersion("v1", [{ r: route.get("/r", { auth: "public", deprecated: true }).handle(() => 1) }], { deprecated: { since: "2026-11-01" } })],
      logger: quiet,
    });
    const res = await own.request("/v1/r");
    assert.equal(res.headers.get("deprecation"), null, "the route's own deprecated option wins");
    assert.equal(own.describe().routes[0]?.deprecated, true);
  });

  test("each version has its own OpenAPI document with the routes outside every version", async () => {
    const app = makeApp();
    const all = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    assert.deepEqual(Object.keys(all.paths).sort(), ["/login", "/v1/tickets", "/v1/tickets/{id}", "/v2", "/v2/tickets", "/v2/tickets/{id}"]);
    const doc1 = (await (await app.request("/v1/openapi.json")).json()) as { info: Record<string, unknown>; paths: Record<string, Record<string, { operationId: string; deprecated?: boolean }>> };
    assert.deepEqual(Object.keys(doc1.paths).sort(), ["/login", "/v1/tickets", "/v1/tickets/{id}"]);
    assert.equal(doc1.info["x-inferlo-api-version"], "v1");
    assert.equal(doc1.paths["/v1/tickets"]!.get!.operationId, "v1_listTickets");
    assert.equal(doc1.paths["/v1/tickets"]!.get!.deprecated, true);
    const doc2 = app.openapi({ version: "v2" }) as { paths: Record<string, unknown> };
    assert.deepEqual(Object.keys(doc2.paths).sort(), ["/login", "/v2", "/v2/tickets", "/v2/tickets/{id}"]);
    assert.equal((await app.request("/v3/openapi.json")).status, 404);
    assert.equal(code(() => app.openapi({ version: "v3" })), "IL6025");
    const off = createApp({ routes: [apiVersion("v1", [v1])], openapi: false, logger: quiet });
    assert.equal((await off.request("/v1/openapi.json")).status, 404);
    assert.deepEqual(off.describe().versions, [{ name: "v1", openapi: false }]);
  });

  test("describe() lists the versions and each route's version; MCP tool names stay unique", async () => {
    const app = makeApp();
    const d = app.describe();
    assert.deepEqual(d.versions, [
      { name: "v1", openapi: "/v1/openapi.json" },
      { name: "v2", openapi: "/v2/openapi.json" },
    ]);
    assert.equal(d.routes.find((r) => r.path === "/v2/tickets")?.version, "v2");
    assert.equal(d.routes.find((r) => r.path === "/login")?.version, undefined);
    assert.deepEqual(d.routes.filter((r) => r.tool).map((r) => r.tool), ["v1_listTickets", "v1_getTicket", "v2_listTickets", "v2_getTicket"]);
    assert.deepEqual(createApp({ logger: quiet }).describe().versions, []);
  });

  test("works inside modules and with toNodeHandler fallthrough", async () => {
    const tickets = module("tickets", { routes: [apiVersion("v2", [v2])] });
    const app = createApp({ modules: [tickets], logger: quiet });
    assert.equal(app.describe().routes[0]?.module, "tickets");
    assert.equal(app.describe().routes[0]?.version, "v2");
    const handler = toNodeHandler(app, { fallthrough: true });
    let passed = 0;
    const res = { on() {}, writableFinished: true } as never;
    await handler({ method: "GET", url: "/v1/tickets", headers: {} } as never, res, () => void passed++);
    assert.equal(passed, 1);
  });

  test("checks its arguments (IL6025)", () => {
    assert.equal(code(() => apiVersion("1", [v1])), "IL6025");
    assert.equal(code(() => apiVersion("V1", [v1])), "IL6025");
    assert.equal(code(() => apiVersion("v0", [v1])), "IL6025");
    assert.equal(code(() => apiVersion("v1", v1 as never)), "IL6025");
    assert.equal(code(() => apiVersion("v1", [])), "IL6025");
    assert.equal(code(() => apiVersion("v1", [v1], { sunset: "2027-01-01" } as never)), "IL6025");
    assert.equal(code(() => apiVersion("v2", [apiVersion("v1", [v1])])), "IL6025");
  });

  test("invalid deprecation dates are reported like route options (IL6021)", () => {
    assert.equal(code(() => createApp({ routes: [apiVersion("v1", [v1], { deprecated: { since: "soon" } })], logger: quiet })), "IL6021");
  });

  test("a GET route on a version's OpenAPI path is refused (IL6025)", () => {
    const clash = route.get("/v1/openapi.json", { auth: "public" }).handle(() => ({}));
    assert.equal(code(() => createApp({ routes: [apiVersion("v1", [v1]), { clash }], logger: quiet })), "IL6025");
  });
});
