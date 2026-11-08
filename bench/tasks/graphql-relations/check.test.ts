import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hashToken } from "@browserlessapi/inferlo";
import { app } from "../src/app.ts";

test("notes have an owner field resolved through GET /users with one call per list", async () => {
  assert.match(readFileSync(new URL("../src/routes/graphql.ts", import.meta.url), "utf8"), /relations/, "uses Inferlo's GraphQL relations");
  const alice = await app.db.users.insert({ email: "alice@x.io", name: "Alice" });
  const bob = await app.db.users.insert({ email: "bob@x.io", name: "Bob" });
  await app.db.api_keys.insert({ userId: alice.id, hash: await hashToken("alice-key") });
  for (let i = 0; i < 3; i++) await app.db.notes.insert({ title: `Note ${i}`, ownerId: alice.id });
  await app.db.notes.insert({ title: "Bob's", ownerId: bob.id });
  const ask = async (query: string, token = "alice-key") => {
    const response = await app.request("/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
    return (await response.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  };
  const answer = await ask("{ notes { title owner { id name } } }");
  assert.equal(answer.errors, undefined, JSON.stringify(answer.errors));
  assert.equal(answer.data.notes.length, 3);
  for (const note of answer.data.notes) assert.deepEqual(note.owner, { id: alice.id, name: "Alice" });
  const rest = await app.request(`/users?ids=${bob.id}`, { headers: { authorization: "Bearer alice-key" } });
  assert.equal(rest.status, 200, "GET /users is registered");
  const describe = app.describe();
  const graphql = describe.routes.find((r) => r.path === "/graphql") as { graphql?: { relations?: Record<string, string> } };
  assert.deepEqual(graphql.graphql?.relations, { "notes.owner": "GET /users" }, "owner is a relation field that runs GET /users");
});
