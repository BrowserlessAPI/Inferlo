import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, route, type Middleware } from "../src/index.ts";

const logger = { info() {}, error() {} };
const ping = route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }));
const page = route.get("/page", { auth: "public" }).handle(() => new Response("<h1>Hi</h1>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'self' cdn.example" } }));
const boom = route.get("/boom", { auth: "public" }).handle(() => {
  throw new Error("db password leaked");
});

const DEFAULTS = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function secureHeadersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...Object.keys(DEFAULTS), "strict-transport-security"]) {
    const value = res.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

describe("secure response headers", () => {
  test("are sent by default on every response, including errors, 404s and OpenAPI", async () => {
    const app = createApp({ routes: [{ ping, boom }], logger });
    for (const path of ["/ping", "/boom", "/missing", "/openapi.json"]) {
      const res = await app.request(path);
      assert.deepEqual(secureHeadersOf(res), DEFAULTS, path);
    }
  });

  test("Strict-Transport-Security is only sent over HTTPS", async () => {
    const app = createApp({ routes: [{ ping }], logger });
    const plain = await app.fetch(new Request("http://api.example/ping"));
    assert.equal(plain.headers.get("strict-transport-security"), null);
    const tls = await app.fetch(new Request("https://api.example/ping"));
    assert.equal(tls.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  });

  test("behind a proxy, X-Forwarded-Proto: https counts only with trustProxy", async () => {
    const forwarded = () => new Request("http://api.example/ping", { headers: { "x-forwarded-proto": "https" } });
    assert.equal((await createApp({ routes: [{ ping }], logger }).fetch(forwarded())).headers.get("strict-transport-security"), null);
    const trusted = await createApp({ routes: [{ ping }], trustProxy: true, logger }).fetch(forwarded());
    assert.equal(trusted.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  });

  test("headers a handler sets itself win", async () => {
    const app = createApp({ routes: [{ page }], logger });
    const res = await app.request("/page");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'self'; script-src 'self' cdn.example");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  test("each header can be changed or turned off by name, case-insensitively", async () => {
    const app = createApp({
      routes: [{ ping }],
      secureHeaders: { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": false, "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload", "Permissions-Policy": "camera=()" },
      logger,
    });
    const res = await app.fetch(new Request("https://api.example/ping"));
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(res.headers.get("content-security-policy"), null);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains; preload");
    assert.equal(res.headers.get("permissions-policy"), "camera=()");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("secureHeaders: false turns them all off", async () => {
    const app = createApp({ routes: [{ ping }], secureHeaders: false, logger });
    assert.deepEqual(secureHeadersOf(await app.fetch(new Request("https://api.example/ping"))), {});
  });

  test("responses from middleware and Responses with immutable headers get them too", async () => {
    const shortCircuit: Middleware = async ({ url }, next) => (url.pathname === "/blocked" ? new Response("no", { status: 403 }) : next());
    const immutable = route.get("/redirect", { auth: "public" }).handle(() => Response.redirect("https://example.com/", 302));
    const app = createApp({ routes: [{ immutable }], middleware: [shortCircuit], logger });
    const blocked = await app.request("/blocked");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("x-content-type-options"), "nosniff");
    const redirect = await app.request("/redirect");
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "https://example.com/");
    assert.equal(redirect.headers.get("x-frame-options"), "DENY");
  });

  test("CORS preflight and health endpoints get them too", async () => {
    const app = createApp({ routes: [{ ping }], cors: true, health: true, logger });
    assert.equal((await app.request("/ping", { method: "OPTIONS", headers: { origin: "https://a.example" } })).headers.get("x-content-type-options"), "nosniff");
    assert.equal((await app.request("/ready")).headers.get("x-content-type-options"), "nosniff");
  });

  test("invalid options raise IL6016", () => {
    for (const bad of ["yes", { "X-Frame-Options": 1 }, { "bad header": "x" }, { "X-Frame-Options": "a\nb" }, { "X-Frame-Options": true }]) {
      assert.throws(
        () => createApp({ secureHeaders: bad as never, logger }),
        (e: unknown) => e instanceof InferloError && e.code === "IL6016",
        JSON.stringify(bad),
      );
    }
  });

  test("describe() lists the headers that are sent", () => {
    const app = createApp({ secureHeaders: { "X-Frame-Options": false }, logger });
    const names = app.describe().secureHeaders;
    assert.ok(names.includes("x-content-type-options"));
    assert.ok(names.includes("strict-transport-security"));
    assert.ok(!names.includes("x-frame-options"));
  });
});
