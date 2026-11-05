import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, route } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import { access } from "../src/permissions.ts";
import * as notes from "../src/routes/notes.ts";

test("permission names are typed from Register", () => {
  // @ts-expect-error: a misspelled permission name must be a type error once access is registered.
  route.get("/typo", { permission: "notes.stat" });
  // @ts-expect-error: "notes.delete" needs a note, so it cannot be checked by the route option.
  route.get("/needs-note", { permission: "notes.delete" });
  assert.equal(route.get("/ok", { permission: "notes.stats" }).handle(() => ({})).options.permission, "notes.stats");
});

test("noteStats is an MCP tool listed only for callers with notes.stats", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null }, permissions: access });
  const tools = async (roles: string[]) => {
    const as = { id: "00000000-0000-4000-8000-00000000000a", email: "u@x.io", name: "U", roles };
    const res = await readJson(await app.request("/mcp", { method: "POST", as, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } }), 200);
    return res.result.tools.map((t: { name: string }) => t.name) as string[];
  };
  assert.ok((await tools(["admin"])).includes("noteStats"), "admins see noteStats");
  assert.ok(!(await tools([])).includes("noteStats"), "other users do not");
});
