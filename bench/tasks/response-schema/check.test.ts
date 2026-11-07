import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as profile from "../src/routes/profile.ts";

test("the profile route answers its response schema and nothing else", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*profile/, "registers the profile routes");
  const app = createApp({ models, routes: [profile], db: memory(), auth: { resolve: () => null }, validateResponses: "error" });
  const route = app.describe().routes.find((r) => r.method === "GET" && r.path === "/me/profile");
  assert.ok(route, "GET /me/profile exists");
  const doc = app.openapi() as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>> };
  const schema = doc.paths["/me/profile"]!.get!.responses["200"]!.content?.["application/json"]?.schema;
  assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), ["email", "id", "name"], "the response schema has id, email and name");

  const row = await app.db.users.insert({ email: "ada@example.com", name: "Ada", role: "admin" });
  const user = { id: row.id, email: row.email, name: row.name, roles: ["admin"] };
  assert.equal((await app.request("/me/profile")).status, 401);
  assert.deepEqual(await readJson(await app.request("/me/profile", { as: user }), 200), { id: row.id, email: "ada@example.com", name: "Ada" });
  const ghost = { id: "00000000-0000-4000-8000-00000000dead", email: "g@x.io", name: "G", roles: [] };
  assert.equal((await app.request("/me/profile", { as: ghost })).status, 404);
});
