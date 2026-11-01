import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readJson } from "../src/testing.ts";
import { BOB, makeApp } from "./helpers.ts";

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mcp, openapi and describe", () => {
  test("initialize and tools/list", async () => {
    const app = makeApp();
    const init = await readJson(await app.request("/mcp", { method: "POST", json: rpc("initialize", { protocolVersion: "2025-06-18" }) }), 200);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "test-app");
    const note = await app.request("/mcp", { method: "POST", json: { jsonrpc: "2.0", method: "notifications/initialized" } });
    assert.equal(note.status, 202);
    const list = await readJson(await app.request("/mcp", { method: "POST", json: rpc("tools/list") }), 200);
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ["createPost", "getPost", "listPosts"]);
    const create = list.result.tools.find((t: { name: string }) => t.name === "createPost");
    assert.equal(create.description, "Create a post");
    assert.deepEqual(create.inputSchema.required.sort(), ["authorId", "body", "title"]);
  });

  test("tools/call runs the route with the caller's auth", async () => {
    const app = makeApp();
    const a = await (app.db as any).authors.insert({ name: "A", email: "mcp@x.io" });
    const anon = await readJson(await app.request("/mcp", { method: "POST", json: rpc("tools/call", { name: "createPost", arguments: { title: "t", body: "b", authorId: a.id } }) }), 200);
    assert.equal(anon.result.isError, true);
    assert.match(anon.result.content[0].text, /IL3001/);

    const ok = await readJson(
      await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer bob" }, json: rpc("tools/call", { name: "createPost", arguments: { title: "t", body: "b", authorId: a.id } }) }),
      200,
    );
    assert.equal(ok.result.isError, false);
    const post = JSON.parse(ok.result.content[0].text);
    const got = await readJson(await app.request("/mcp", { method: "POST", as: BOB, json: rpc("tools/call", { name: "getPost", arguments: { id: post.id } }) }), 200);
    assert.equal(JSON.parse(got.result.content[0].text).title, "t");
    const listed = await readJson(await app.request("/mcp", { method: "POST", json: rpc("tools/call", { name: "listPosts", arguments: { limit: 5 } }) }), 200);
    assert.equal(JSON.parse(listed.result.content[0].text).length, 1);
  });

  test("unknown tool and method", async () => {
    const app = makeApp();
    assert.equal((await readJson(await app.request("/mcp", { method: "POST", json: rpc("tools/call", { name: "nope" }) }), 200)).error.code, -32602);
    assert.equal((await readJson(await app.request("/mcp", { method: "POST", json: rpc("bogus") }), 200)).error.code, -32601);
  });

  test("openapi document", async () => {
    const app = makeApp();
    const doc = await readJson(await app.request("/openapi.json"), 200);
    assert.equal(doc.openapi, "3.1.0");
    assert.ok(doc.paths["/posts/{id}"].get);
    assert.equal(doc.paths["/posts"].post.operationId, "createPost");
    assert.deepEqual(doc.paths["/posts"].post.security, [{ bearerAuth: [] }]);
    assert.ok(doc.components.schemas.posts.properties.title);
  });

  test("describe gives a full app map", () => {
    const d = makeApp().describe();
    assert.equal(d.name, "test-app");
    assert.equal(d.database, "memory");
    assert.equal(d.endpoints.mcp, "/mcp");
    const posts = d.models.find((m) => m.name === "posts")!;
    assert.equal(posts.fields.authorId!.references, "authors");
    assert.equal(posts.fields.authorId!.column, "author_id");
    const del = d.routes.find((r) => r.name === "deletePost")!;
    assert.equal(del.auth, "admin");
  });
});
