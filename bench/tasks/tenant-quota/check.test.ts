import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as projects from "../src/routes/projects.ts";

const user = (id: string, tenantId: string) => ({ id, email: `${id.slice(0, 4)}@x.io`, name: "U", roles: [], tenantId });
const ada = user("11111111-1111-4111-8111-111111111111", "acme");
const ben = user("33333333-3333-4333-8333-333333333333", "acme");
const eve = user("22222222-2222-4222-8222-222222222222", "globex");

test("an organisation shares one limit of 3 new projects per hour", async () => {
  const app = createApp({ models, routes: [projects], db: memory(), auth: { resolve: () => null } });
  for (const [i, who] of [ada, ben, ada].entries()) await readJson(await app.request("/projects", { method: "POST", json: { name: `P${i}` }, as: who }), 201);
  const limited = await app.request("/projects", { method: "POST", json: { name: "P4" }, as: ben });
  assert.equal(limited.status, 429, "the 4th project of the organisation is refused, whoever creates it");
  await readJson(await app.request("/projects", { method: "POST", json: { name: "G1" }, as: eve }), 201);
});

test("GET /projects/stats is cached per organisation", async () => {
  const app = createApp({ models, routes: [projects], db: memory(), auth: { resolve: () => null } });
  for (const name of ["A", "B"]) await readJson(await app.request("/projects", { method: "POST", json: { name }, as: ada }), 201);
  await readJson(await app.request("/projects", { method: "POST", json: { name: "G" }, as: eve }), 201);

  const first = await app.request("/projects/stats", { as: ada });
  assert.deepEqual(await readJson(first), { count: 2 });
  assert.equal(first.headers.get("x-inferlo-cache"), "MISS", "a cached route");
  const shared = await app.request("/projects/stats", { as: ben });
  assert.equal(shared.headers.get("x-inferlo-cache"), "HIT", "users of one organisation share the cached answer");
  assert.deepEqual(await readJson(shared), { count: 2 });
  const other = await app.request("/projects/stats", { as: eve });
  assert.deepEqual(await readJson(other), { count: 1 }, "another organisation gets its own count");
  assert.ok(app.describe().routes.some((r) => r.path === "/projects/stats" && r.cache?.ttlMs === 60_000), "cached for 60 seconds");
});
