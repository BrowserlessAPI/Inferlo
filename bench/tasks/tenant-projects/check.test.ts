import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as projects from "../src/routes/projects.ts";

test("projects are tenant-scoped by the user's organisation", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/projects/, "registers the projects routes");
  const Project = models.find((m) => m.name === "projects");
  assert.ok(Project, "a projects model is registered");
  assert.equal(Project.tenant, true, "projects is tenant-scoped");
  const routesFile = readFileSync(new URL("../src/routes/projects.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routesFile, /tenantId|orgId/, "no hand-written tenant filter");

  const app = createApp({ models, routes: [projects], db: memory(), auth: { resolve: () => null } });
  const user = (id: string, tenantId: string) => ({ id, email: `${id.slice(0, 4)}@x.io`, name: "U", roles: [], tenantId });
  const ada = user("11111111-1111-4111-8111-111111111111", "acme");
  const ben = user("22222222-2222-4222-8222-222222222222", "acme");
  const cy = user("33333333-3333-4333-8333-333333333333", "globex");

  const created = await readJson(await app.request("/projects", { method: "POST", json: { name: "Apollo" }, as: ada }), 201);
  assert.equal(created.name, "Apollo");
  assert.equal(created.tenantId, "acme");
  await readJson(await app.request("/projects", { method: "POST", json: { name: "Gemini" }, as: ben }), 201);
  await readJson(await app.request("/projects", { method: "POST", json: { name: "Orion" }, as: cy }), 201);

  const acme = await readJson(await app.request("/projects", { as: ben }), 200);
  assert.deepEqual(acme.map((p: { name: string }) => p.name), ["Apollo", "Gemini"]);
  const globex = await readJson(await app.request("/projects", { as: cy }), 200);
  assert.deepEqual(globex.map((p: { name: string }) => p.name), ["Orion"]);
  await readJson(await app.request("/projects", { method: "POST", json: { name: "" }, as: cy }), 422);

  const u = await app.db.users.insert({ email: "o@x.io", name: "O" });
  assert.equal(u.orgId, "personal", "users get orgId with a default");
});
