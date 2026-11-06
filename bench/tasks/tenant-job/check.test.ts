import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as projects from "../src/routes/projects.ts";
import * as jobs from "../src/jobs.ts";

test("rename-project runs in a job, for the organisation that queued it", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /jobs:\s*\[\s*jobs\s*\]/, "registers the jobs module");
  const app = createApp({ models, routes: [projects], jobs: [jobs], db: memory(), auth: { resolve: () => null } });
  assert.ok(app.jobs.list.some((j) => j.name === "rename-project"), "a rename-project job");
  const user = (id: string, tenantId: string) => ({ id, email: `${id.slice(0, 4)}@x.io`, name: "U", roles: [], tenantId });
  const ada = user("11111111-1111-4111-8111-111111111111", "acme");
  const eve = user("22222222-2222-4222-8222-222222222222", "globex");

  const project = await readJson(await app.request("/projects", { method: "POST", json: { name: "Apollo" }, as: ada }), 201);
  const queued = await readJson(await app.request(`/projects/${project.id}/rename`, { method: "POST", json: { name: "Artemis" }, as: ada }), 202);
  assert.deepEqual(queued, { queued: true });
  const acme = app.db.$tenant("acme");
  assert.equal((await acme.projects.get(project.id)).name, "Apollo", "not renamed during the request");
  await app.jobs.runDue();
  assert.equal((await acme.projects.get(project.id)).name, "Artemis", "renamed by the job");

  const res = await app.request(`/projects/${project.id}/rename`, { method: "POST", json: { name: "Hacked" }, as: eve });
  assert.ok(res.status === 202 || res.status === 404, `another organisation gets 202 or 404, got ${res.status}`);
  await app.jobs.runDue();
  assert.equal((await acme.projects.get(project.id)).name, "Artemis", "another organisation cannot rename it");
  await readJson(await app.request(`/projects/${project.id}/rename`, { method: "POST", json: { name: "" }, as: ada }), 422);
});
