import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { startStandaloneServer } from "@apollo/server/standalone";
import { hashToken } from "@browserlessapi/inferlo";
import { app } from "../src/app.ts";
import { context, server } from "../src/graphql.ts";

test("Apollo Server runs the notes routes as the caller of the request", async (t) => {
  assert.match(readFileSync(new URL("../src/graphql.ts", import.meta.url), "utf8"), /@browserlessapi\/inferlo\/graphql/, "uses Inferlo's GraphQL integration");
  const { url } = await startStandaloneServer(server, { listen: { port: 0, host: "127.0.0.1" }, context });
  t.after(() => server.stop());
  const alice = await app.db.users.insert({ email: "alice@x.io", name: "Alice" });
  const bob = await app.db.users.insert({ email: "bob@x.io", name: "Bob" });
  await app.db.api_keys.insert({ userId: alice.id, hash: await hashToken("alice-key") });
  await app.db.api_keys.insert({ userId: bob.id, hash: await hashToken("bob-key") });
  const ask = async (query: string, token?: string, variables?: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string; status?: number } }[] };
  };

  const created = await ask('mutation { createNote(title: "Groceries", body: "Milk") { id title ownerId } }', "alice-key");
  assert.equal(created.errors, undefined, JSON.stringify(created.errors));
  assert.equal(created.data.createNote.ownerId, alice.id, "runs as the signed-in user");
  const id = created.data.createNote.id;
  assert.deepEqual(await ask("query ($id: String!) { note(id: $id) { title } notes { title } }", "alice-key", { id }), { data: { note: { title: "Groceries" }, notes: [{ title: "Groceries" }] } });
  const other = await ask("query ($id: String!) { note(id: $id) { title } }", "bob-key", { id });
  assert.equal(other.errors?.[0]?.extensions?.status, 404, "the route's ownership check still applies");
  const invalid = await ask('mutation { createNote(title: "") { id } }', "alice-key");
  assert.equal(invalid.errors?.[0]?.extensions?.status, 422, "the route's validation still applies");
  const anonymous = await ask("{ notes { title } }");
  assert.equal(anonymous.errors?.[0]?.extensions?.code, "IL3001", "the routes stay private");
});
