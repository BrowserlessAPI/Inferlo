import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notesRoutes from "../src/routes/notes.ts";
import * as graphqlRoutes from "../src/routes/graphql.ts";

test("describe() lists the GraphQL mutations and the routes they run", async () => {
  const app = createApp({ models, routes: [notesRoutes, graphqlRoutes], db: memory(), auth: { resolve: () => null } });
  const routes = app.describe().routes;
  const endpoint = routes.find((r) => r.path === "/graphql");
  assert.ok(endpoint?.graphql, "POST /graphql is a GraphQL endpoint");
  assert.deepEqual(Object.keys(endpoint.graphql.query).sort(), ["note", "notes"], "the query fields are unchanged");
  assert.equal(endpoint.graphql.mutation.createNote, "POST /notes");
  assert.match(endpoint.graphql.mutation.updateNote ?? "", /^(PATCH|PUT) \/notes\/:id$/);
  assert.equal(endpoint.graphql.mutation.deleteNote, "DELETE /notes/:id");
  assert.deepEqual(routes.find((r) => r.method === "DELETE" && r.path === "/notes/:id")?.graphqlFields, ["Mutation.deleteNote"]);
  const user = await app.db.users.insert({ email: "alice@x.io", name: "Alice" });
  const as = { id: user.id, email: "alice@x.io", name: "Alice", roles: [] };
  const ask = async (query: string) => (await (await app.request("/graphql", { method: "POST", json: { query }, as })).json()) as { data?: any; errors?: unknown[] };
  const created = await ask('mutation { createNote(title: "A", body: "B") { id } }');
  const id = created.data.createNote.id;
  const updated = await ask(`mutation { updateNote(id: "${id}", title: "C") }`);
  assert.equal(updated.errors, undefined, JSON.stringify(updated.errors));
  assert.equal(updated.data.updateNote.title, "C", "updateNote answers the updated note (JSON without a response schema)");
  const deleted = await ask(`mutation { deleteNote(id: "${id}") }`);
  assert.equal(deleted.errors, undefined, JSON.stringify(deleted.errors));
  assert.deepEqual((await ask("{ notes { id } }")).data.notes, []);
});
