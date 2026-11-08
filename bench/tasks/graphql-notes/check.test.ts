import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notesRoutes from "../src/routes/notes.ts";
import * as graphqlRoutes from "../src/routes/graphql.ts";

test("POST /graphql runs the notes routes as the signed-in user", async () => {
  assert.match(readFileSync(new URL("../src/routes/graphql.ts", import.meta.url), "utf8"), /@browserlessapi\/inferlo\/graphql/, "uses Inferlo's GraphQL integration");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/graphql/, "registers the route module");
  const app = createApp({ models, routes: [notesRoutes, graphqlRoutes], db: memory(), auth: { resolve: () => null } });
  const alice = await app.db.users.insert({ email: "alice@x.io", name: "Alice" });
  const bob = await app.db.users.insert({ email: "bob@x.io", name: "Bob" });
  const as = (user: { id: string }) => ({ id: user.id, email: "x@x.io", name: "X", roles: [] });
  const ask = async (query: string, user: { id: string }, variables?: Record<string, unknown>) =>
    (await readJson(await app.request("/graphql", { method: "POST", json: { query, variables }, as: as(user) }), 200)) as { data?: any; errors?: { message: string; extensions?: { status?: number } }[] };

  const created = await ask('mutation { createNote(title: "Groceries", body: "Milk") { id title body ownerId } }', alice);
  assert.equal(created.errors, undefined, JSON.stringify(created.errors));
  assert.equal(created.data.createNote.title, "Groceries");
  assert.equal(created.data.createNote.ownerId, alice.id);
  const id = created.data.createNote.id;
  assert.deepEqual(await ask("query ($id: String!) { note(id: $id) { title } notes { title } }", alice, { id }), { data: { note: { title: "Groceries" }, notes: [{ title: "Groceries" }] } });
  const other = await ask("query ($id: String!) { note(id: $id) { title } }", bob, { id });
  assert.equal(other.errors?.[0]?.extensions?.status, 404, "the route's ownership check still applies");
  assert.deepEqual(await ask("{ notes { title } }", bob), { data: { notes: [] } });
  const invalid = await ask('mutation { createNote(title: "") { id } }', alice);
  assert.equal(invalid.errors?.[0]?.extensions?.status, 422, "the route's validation still applies");
  assert.match((await ask("{ __schema { types { name } } }", alice)).errors?.[0]?.message ?? "", /introspection/i);
  assert.equal((await app.request("/graphql", { method: "POST", json: { query: "{ notes { title } }" } })).status, 401, "the endpoint is private");
});
