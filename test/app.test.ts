import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, route, t } from "../src/index.ts";
import { readJson } from "../src/testing.ts";
import { ALICE, BOB, makeApp } from "./helpers.ts";

async function author(app: ReturnType<typeof makeApp>) {
  return (app.db as any).authors.insert({ name: "A", email: `a${Math.random()}@x.io` });
}

describe("routing and requests", () => {
  test("public route", async () => {
    const app = makeApp();
    assert.deepEqual(await readJson(await app.request("/health"), 200), { ok: true });
  });

  test("private by default: 401 without user", async () => {
    const app = makeApp();
    const res = await app.request("/posts", { method: "POST", json: {} });
    const body = await readJson(res, 401);
    assert.equal(body.error.code, "IL3001");
    assert.ok(body.error.docs.includes("il3001"));
  });

  test("bearer auth resolves the user", async () => {
    const app = makeApp();
    const body = await readJson(await app.request("/me", { headers: { authorization: "Bearer bob" } }), 200);
    assert.deepEqual(body.user, BOB);
  });

  test("create, read, validation and 404", async () => {
    const app = makeApp();
    const a = await author(app);
    const created = await readJson(await app.request("/posts", { method: "POST", json: { title: "Hello", body: "World", authorId: a.id }, as: BOB }), 201);
    assert.equal(created.title, "Hello");
    assert.equal(created.views, 0);
    assert.equal(created.kind, "note");
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.ok(created.createdAt);

    const got = await readJson(await app.request(`/posts/${created.id}`), 200);
    assert.equal(got.id, created.id);

    const bad = await readJson(await app.request("/posts", { method: "POST", json: { title: "", body: "x", authorId: a.id, titel: "y" }, as: BOB }), 422);
    assert.equal(bad.error.code, "IL1001");
    const codes = bad.error.details.map((i: { code: string }) => i.code);
    assert.ok(codes.includes("too_short"));
    assert.ok(codes.includes("unknown_key"));

    const missing = await readJson(await app.request("/posts/33333333-3333-4333-8333-333333333333"), 404);
    assert.equal(missing.error.code, "IL4001");

    const badId = await readJson(await app.request("/posts/not-a-uuid"), 422);
    assert.equal(badId.error.code, "IL1001");
  });

  test("query strings are coerced and unknown query keys ignored", async () => {
    const app = makeApp();
    const a = await author(app);
    for (let i = 0; i < 3; i++) await (app.db as any).posts.insert({ title: `p${i}`, body: "b", authorId: a.id, kind: i ? "article" : "note" });
    const all = await readJson(await app.request("/posts?limit=2&utm_source=x"), 200);
    assert.equal(all.length, 2);
    const articles = await readJson(await app.request("/posts?kind=article"), 200);
    assert.equal(articles.length, 2);
    const tooMany = await readJson(await app.request("/posts?limit=500"), 422);
    assert.equal(tooMany.error.code, "IL1001");
  });

  test("role checks", async () => {
    const app = makeApp();
    const a = await author(app);
    const p = await (app.db as any).posts.insert({ title: "x", body: "y", authorId: a.id });
    assert.equal((await readJson(await app.request(`/posts/${p.id}`, { method: "DELETE", as: BOB }), 403)).error.code, "IL3002");
    assert.equal((await app.request(`/posts/${p.id}`, { method: "DELETE", as: ALICE })).status, 204);
  });

  test("404 suggests the closest route, 405 lists allowed methods", async () => {
    const app = makeApp();
    const nf = await readJson(await app.request("/post"), 404);
    assert.equal(nf.error.code, "IL2001");
    assert.match(nf.error.message, /Closest route: \/posts/);
    const res = await app.request("/health", { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  });

  test("invalid JSON and wildcard paths", async () => {
    const app = makeApp();
    const res = await app.request("/posts", { method: "POST", body: "{nope", headers: { "content-type": "application/json" }, as: BOB });
    assert.equal((await readJson(res, 400)).error.code, "IL2003");
    assert.deepEqual(await readJson(await app.request("/files/a/b/c.txt"), 200), { path: "a/b/c.txt" });
  });

  test("unexpected errors are hidden from clients", async () => {
    const app = makeApp();
    const body = await readJson(await app.request("/boom"), 500);
    assert.equal(body.error.code, "IL9000");
    assert.ok(!JSON.stringify(body).includes("secret internals"));
  });

  test("CORS preflight and allowed origin", async () => {
    const app = makeApp();
    const pre = await app.request("/posts", { method: "OPTIONS", headers: { origin: "https://ok.example" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://ok.example");
    const other = await app.request("/health", { headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  test("body size limit", async () => {
    const app = createApp({ routes: [route.post("/x", { auth: "public", body: t.object({ s: t.string() }) }).handle(({ body }) => body.s.length)], maxBodySize: 100, logger: { info() {}, error() {} } });
    const res = await app.request("/x", { method: "POST", json: { s: "a".repeat(500) } });
    assert.equal((await readJson(res, 413)).error.code, "IL2004");
  });

  test("middleware runs around requests", async () => {
    const app = createApp({
      routes: [route.get("/x", { auth: "public" }).handle(() => "ok")],
      middleware: [
        async (_ctx, next) => {
          const res = await next();
          res.headers.set("x-mw", "1");
          return res;
        },
      ],
    });
    const res = await app.request("/x");
    assert.equal(res.headers.get("x-mw"), "1");
  });
});

describe("config checks", () => {
  test("private routes without auth fail at startup (IL3003)", () => {
    assert.throws(() => createApp({ routes: [route.get("/x").handle(() => 1)] }), (e: unknown) => e instanceof InferloError && e.code === "IL3003");
  });

  test("duplicate routes fail (IL6001)", () => {
    const r = () => route.get("/x/:id", { auth: "public" }).handle(() => 1);
    assert.throws(() => createApp({ routes: [r(), route.get("/x/:other", { auth: "public" }).handle(() => 2)] }), /IL6001|Duplicate/);
  });

  test("unknown ref fails (IL6005)", async () => {
    const { model } = await import("../src/index.ts");
    const M = model("things", { ownerId: t.ref("userz") });
    assert.throws(() => createApp({ models: [M] }), /userz/);
  });

  test("route export names come from modules", () => {
    const app = makeApp();
    assert.ok(app.routes.some((r) => r.name === "createPost"));
  });
});

describe("listen", () => {
  test("serves over real HTTP", async () => {
    const app = makeApp();
    const server = await app.listen(0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      assert.deepEqual(await res.json(), { ok: true });
      const post = await fetch(`http://127.0.0.1:${server.port}/posts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bob" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(post.status, 422);
    } finally {
      await server.close();
    }
  });
});
