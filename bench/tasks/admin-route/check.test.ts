import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";
import { app } from "../src/app.ts";

test("admin users route", async () => {
  await app.db.users.insert({ email: "b@x.io", name: "B" });
  await app.db.users.insert({ email: "a@x.io", name: "A", role: "admin" });
  const member = { id: "00000000-0000-4000-8000-000000000001", email: "m@x.io", name: "M", roles: ["member"] };
  const admin = { id: "00000000-0000-4000-8000-000000000002", email: "a@x.io", name: "A", roles: ["admin"] };
  assert.equal((await app.request("/admin/users")).status, 401);
  assert.equal((await app.request("/admin/users", { as: member })).status, 403);
  const users = await readJson(await app.request("/admin/users", { as: admin }), 200);
  assert.deepEqual(users.map((u: { email: string }) => u.email), ["a@x.io", "b@x.io"]);
});
