// Apollo Server serving graphqlSchema() with graphqlContext(app, req): fields run the app's routes as the caller.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { expressMiddleware } from "@as-integrations/express5";
import express from "express";
import { bearer, createApp, memory, model, notFound, permissions, route, t, type AppUser } from "../src/index.ts";
import { graphqlContext, graphqlSchema, type GraphQLContext } from "../src/graphql.ts";

const notes = model("notes", { title: t.string().max(20), priority: t.enum(["low", "high"]) });

const listNotes = route.get("/notes", { response: t.array(notes.row) }).handle(({ db }) => db.notes!.findMany({ orderBy: { createdAt: "asc" } }));
const getNote = route.get("/notes/:id", { params: t.object({ id: t.uuid() }), response: notes.row }).handle(async ({ db, params }) => {
  const note = await db.notes!.find(params.id);
  if (!note) throw notFound("Note not found");
  return note;
});
const createNote = route
  .post("/notes", { body: t.object({ title: t.string().max(20), priority: t.enum(["low", "high"]).default("low") }), response: notes.row })
  .handle(({ db, body }) => db.notes!.insert(body));
const deleteNote = route.delete("/notes/:id", { permission: "notes.delete" }).handle(async ({ db, params, status }) => {
  await db.notes!.delete(params.id);
  status(204);
});
const whoami = route.get("/whoami", { response: t.object({ id: t.string() }) }).handle(({ user }) => ({ id: String(user.id) }));
const limited = route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" }, response: t.object({ ok: t.boolean() }) }).handle(() => ({ ok: true }));

const users: Record<string, AppUser> = {
  admin: { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] },
  reader: { id: "22222222-2222-4222-8222-222222222222", roles: [] },
};

function makeApp() {
  return createApp({
    models: [notes],
    db: memory(),
    routes: [{ listNotes, getNote, createNote, deleteNote, whoami, limited }],
    auth: bearer((token) => users[token] ?? null),
    permissions: permissions({ "notes.delete": ({ user }: { user: AppUser }) => (user.roles ?? []).includes("admin") }),
  });
}

const schema = graphqlSchema({
  query: { notes: listNotes, note: getNote, whoami, limited },
  mutation: { createNote, deleteNote },
});

type Answer = { data?: any; errors?: { message: string; path?: string[]; extensions?: { code?: string; status?: number } }[] };

const post = async (url: string, query: string, token?: string, variables?: unknown): Promise<Answer> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
  });
  return (await response.json()) as Answer;
};

describe("graphqlContext() with Apollo Server's standalone server", () => {
  const app = makeApp();
  const server = new ApolloServer<GraphQLContext>({ schema });
  let url = "";
  before(async () => {
    // listen port 0 picks a free port.
    ({ url } = await startStandaloneServer(server, { listen: { port: 0, host: "127.0.0.1" }, context: async ({ req }) => graphqlContext(app, req) }));
  });
  after(() => server.stop());

  test("queries and mutations run the routes as the signed-in caller", async () => {
    const created = await post(url, 'mutation { createNote(title: "Hello", priority: high) { id title priority } }', "admin");
    assert.equal(created.errors, undefined);
    assert.equal(created.data.createNote.title, "Hello");
    assert.equal(created.data.createNote.priority, "high");
    const listed = await post(url, "query($id: String!) { notes { title } note(id: $id) { title } whoami { id } }", "reader", { id: created.data.createNote.id });
    assert.equal(listed.errors, undefined);
    assert.deepEqual(listed.data, { notes: [{ title: "Hello" }], note: { title: "Hello" }, whoami: { id: users.reader!.id } });
    // The same rows as the REST routes.
    const rest = await app.request("/notes", { headers: { authorization: "Bearer admin" } });
    assert.equal(((await rest.json()) as unknown[]).length, 1);
  });

  test("each route keeps its auth, permissions and validation, with Inferlo's error codes", async () => {
    const anonymous = await post(url, "{ whoami { id } }");
    assert.equal(anonymous.data, null);
    assert.equal(anonymous.errors![0]!.extensions!.code, "IL3001");
    const created = await post(url, 'mutation { createNote(title: "Keep") { id } }', "admin");
    const denied = await post(url, `mutation { deleteNote(id: "${created.data.createNote.id}") }`, "reader");
    assert.equal(denied.errors![0]!.extensions!.code, "IL3004");
    assert.deepEqual(denied.errors![0]!.path, ["deleteNote"]);
    const deleted = await post(url, `mutation { deleteNote(id: "${created.data.createNote.id}") }`, "admin");
    assert.equal(deleted.errors, undefined);
    assert.equal(deleted.data.deleteNote, null);
    const tooLong = await post(url, 'mutation { createNote(title: "This title is far too long for the route") { id } }', "admin");
    assert.equal(tooLong.errors![0]!.extensions!.code, "IL1001");
    assert.equal(tooLong.errors![0]!.extensions!.status, 422);
    const missing = await post(url, '{ note(id: "33333333-3333-4333-8333-333333333333") { id } }', "admin");
    assert.equal(missing.errors![0]!.message, "Note not found");
    assert.equal(missing.errors![0]!.extensions!.status, 404);
  });

  test("per-IP rate limits use the client address of the Node.js request", async () => {
    assert.deepEqual((await post(url, "{ limited { ok } }")).data, { limited: { ok: true } });
    const second = await post(url, "{ limited { ok } }");
    assert.equal(second.errors![0]!.extensions!.status, 429);
  });
});

describe("graphqlContext() with Apollo Server's Express middleware", () => {
  const app = makeApp();
  const apollo = new ApolloServer<GraphQLContext>({ schema });
  let server: Server;
  let url = "";
  before(async () => {
    await apollo.start();
    const web = express();
    web.use("/graphql", express.json(), expressMiddleware(apollo, { context: async ({ req }) => graphqlContext(app, req) }));
    server = web.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await apollo.stop();
  });

  test("credentials come from the Express request", async () => {
    assert.deepEqual((await post(url, "{ whoami { id } }", "admin")).data, { whoami: { id: users.admin!.id } });
    assert.equal((await post(url, "{ whoami { id } }")).errors![0]!.extensions!.code, "IL3001");
    const created = await post(url, 'mutation { createNote(title: "Express") { title } }', "reader");
    assert.deepEqual(created.data, { createNote: { title: "Express" } });
  });

  test("executeOperation with the context of a Web Request runs the route as that caller", async () => {
    const answer = await apollo.executeOperation(
      { query: "{ whoami { id } }" },
      { contextValue: graphqlContext(app, new Request("http://localhost/graphql", { headers: { authorization: "Bearer reader" } })) },
    );
    assert.equal(answer.body.kind, "single");
    // Apollo builds data objects without a prototype; compare plain copies.
    const result = JSON.parse(JSON.stringify((answer.body as { singleResult: Answer }).singleResult)) as Answer;
    assert.deepEqual(result.data, { whoami: { id: users.reader!.id } });
  });

  test("without graphqlContext the fields answer IL6059", async () => {
    const answer = await apollo.executeOperation({ query: "{ whoami { id } }" }, { contextValue: {} as GraphQLContext });
    const result = (answer.body as { singleResult: Answer }).singleResult;
    assert.equal(result.errors![0]!.extensions!.code, "IL6059");
    assert.match(result.errors![0]!.message, /graphqlContext/);
  });
});
