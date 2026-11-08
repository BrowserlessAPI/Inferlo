// GraphQL endpoint over the app's routes (@browserlessapi/inferlo/graphql), executed with graphql-js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { printSchema } from "graphql";
import { bearer, createApp, InferloError, memory, model, notFound, permissions, route, t, type AppUser } from "../src/index.ts";
import { graphqlRoute, graphqlSchema } from "../src/graphql.ts";
import { readJson } from "../src/testing.ts";

const notes = model("notes", { title: t.string().max(20), priority: t.enum(["low", "high"]), tags: t.array(t.string()), meta: t.json().optional() });

const listNotes = route
  .get("/notes", { query: t.object({ limit: t.int().min(1).max(50).default(10) }), response: t.array(notes.row), summary: "List notes" })
  .handle(({ db, query }) => db.notes!.findMany({ limit: query.limit, orderBy: { createdAt: "asc" } }));
const getNote = route.get("/notes/:id", { params: t.object({ id: t.uuid() }), response: notes.row }).handle(async ({ db, params }) => {
  const note = await db.notes!.find(params.id);
  if (!note) throw notFound("Note not found");
  return note;
});
const createNote = route
  .post("/notes", { body: t.object({ title: t.string().max(20), priority: t.enum(["low", "high"]).default("low"), tags: t.array(t.string()).default([]) }), response: notes.row })
  .handle(({ db, body }) => db.notes!.insert(body));
const deleteNote = route.delete("/notes/:id", { permission: "notes.delete" }).handle(async ({ db, params, status }) => {
  await db.notes!.delete(params.id);
  status(204);
});
const hello = route.get("/hello", { auth: "public" }).handle(() => ({ hello: "world" }));
const notRegistered = route.get("/elsewhere").handle(() => ({}));

const users: Record<string, AppUser> = {
  admin: { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] },
  reader: { id: "22222222-2222-4222-8222-222222222222", roles: [] },
};

function makeApp(options: Partial<Parameters<typeof graphqlRoute>[0]> = {}) {
  const graphql = graphqlRoute({ query: { notes: listNotes, note: getNote, hello, elsewhere: notRegistered }, mutation: { createNote, deleteNote }, ...options });
  return createApp({
    models: [notes],
    db: memory(),
    routes: [{ listNotes, getNote, createNote, deleteNote, hello, graphql }],
    auth: bearer((token) => users[token] ?? null),
    permissions: permissions({ "notes.delete": ({ user }: { user: AppUser }) => (user.roles ?? []).includes("admin") }),
  });
}

async function gql(app: ReturnType<typeof makeApp>, query: string, options: { token?: string; variables?: unknown; path?: string } = {}) {
  const response = await app.request(options.path ?? "/graphql", {
    method: "POST",
    json: { query, ...(options.variables !== undefined ? { variables: options.variables } : {}) },
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  return { status: response.status, body: (await response.json()) as { data?: any; errors?: { message: string; path?: string[]; extensions?: { code?: string; status?: number } }[] } };
}

describe("graphqlSchema()", () => {
  test("query and mutation fields come from the routes: arguments from params, query and body, types from the response", () => {
    const sdl = printSchema(graphqlSchema({ query: { notes: listNotes, note: getNote, hello }, mutation: { createNote } }));
    assert.match(sdl, /type Query \{/);
    assert.match(sdl, /"""List notes"""\s+notes\(limit: Int\): \[NotesResult!\]!/);
    assert.match(sdl, /note\(id: String!\): NotesResult!/, "an identical shape reuses one type");
    assert.match(sdl, /hello: JSON/, "without a response schema the field is JSON");
    assert.match(sdl, /createNote\(title: String!, priority: CreateNotePriority, tags: \[String!\]\): NotesResult!/);
    assert.match(sdl, /type NotesResult \{\s+id: String!\s+createdAt: String!\s+updatedAt: String!\s+title: String!\s+priority: CreateNotePriority!\s+tags: \[String!\]!\s+meta: JSON\s+\}/);
    assert.match(sdl, /enum CreateNotePriority \{\s+low\s+high\s+\}/);
    assert.match(sdl, /scalar JSON/);
  });

  test("invalid options are refused when the app starts", () => {
    const code = (fn: () => unknown) => assert.throws(fn, (e: InferloError) => e.code === "IL6059");
    code(() => graphqlRoute(undefined as never));
    code(() => graphqlRoute({ query: {} }));
    code(() => graphqlRoute({ query: { "bad-name": listNotes } }));
    code(() => graphqlRoute({ query: { notes: {} as never } }));
    code(() => graphqlRoute({ query: { notes: listNotes }, mutation: [] as never }));
    code(() => graphqlRoute({ query: { notes: listNotes }, pathh: "/x" } as never));
    code(() => graphqlRoute({ query: { notes: listNotes }, path: "graphql" }));
    code(() => graphqlRoute({ query: { notes: listNotes }, maxFields: 0 }));
    code(() => graphqlRoute({ query: { notes: listNotes }, introspection: "no" as never }));
  });
});

describe("graphqlRoute()", () => {
  test("mutations and queries run the routes as the caller", async () => {
    const app = makeApp();
    const created = await gql(app, 'mutation { a: createNote(title: "First", priority: high, tags: ["x"]) { id title priority tags } b: createNote(title: "Second") { id } }', { token: "admin" });
    assert.equal(created.status, 200);
    assert.equal(created.body.errors, undefined);
    assert.deepEqual({ ...created.body.data.a, id: undefined }, { id: undefined, title: "First", priority: "high", tags: ["x"] });
    const id = created.body.data.a.id as string;
    const read = await gql(app, "query ($id: String!) { note(id: $id) { title } notes(limit: 1) { title } hello }", { token: "reader", variables: { id } });
    assert.deepEqual(read.body, { data: { note: { title: "First" }, notes: [{ title: "First" }], hello: { hello: "world" } } });
  });

  test("route errors are GraphQL errors with the route's code; other fields still answer", async () => {
    const app = makeApp();
    const { body } = await gql(app, 'mutation { createNote(title: "This title is far too long") { id } }', { token: "admin" });
    assert.equal(body.data, null);
    assert.equal(body.errors![0]!.extensions!.status, 422);
    assert.deepEqual(body.errors![0]!.path, ["createNote"]);
    const created = await gql(app, 'mutation { createNote(title: "Keep") { id } }', { token: "admin" });
    const id = created.body.data.createNote.id;
    const denied = await gql(app, `mutation { deleteNote(id: "${id}") }`, { token: "reader" });
    assert.equal(denied.body.errors![0]!.extensions!.code, "IL3004");
    assert.deepEqual(denied.body.data, { deleteNote: null });
    const missing = await gql(app, 'query { note(id: "33333333-3333-4333-8333-333333333333") { title } hello }', { token: "reader" });
    assert.equal(missing.body.errors![0]!.extensions!.status, 404);
    assert.equal(missing.body.errors![0]!.message, "Note not found");
    assert.equal(missing.body.data, null, "a non-null field that fails nulls the whole data");
    const deleted = await gql(app, `mutation { deleteNote(id: "${id}") }`, { token: "admin" });
    assert.deepEqual(deleted.body, { data: { deleteNote: null } });
    const hidden = await gql(app, "query { elsewhere }", { token: "reader" });
    assert.deepEqual(hidden.body.errors![0]!.message, "Internal error.");
    assert.equal(hidden.body.errors![0]!.extensions!.code, "IL5011", "a route that is not registered with the app");
  });

  test("the endpoint is private by default; with auth public each field's route still checks its own auth", async () => {
    const privateApp = makeApp();
    assert.equal((await gql(privateApp, "{ hello }")).status, 401);
    const publicApp = makeApp({ auth: "public" });
    assert.deepEqual((await gql(publicApp, "{ hello }")).body, { data: { hello: { hello: "world" } } });
    const anonymous = await gql(publicApp, "{ notes { title } }");
    assert.equal(anonymous.body.errors![0]!.extensions!.status, 401);
    assert.equal(anonymous.body.errors![0]!.extensions!.code, "IL3001");
  });

  test("syntax and validation errors, top-level field limits and introspection", async () => {
    const app = makeApp({ maxFields: 2, introspection: false, path: "/api/graphql" });
    const opts = { token: "reader", path: "/api/graphql" };
    const syntax = await gql(app, "{ notes { ", opts);
    assert.equal(syntax.status, 200);
    assert.match(syntax.body.errors![0]!.message, /Syntax Error/);
    assert.equal(syntax.body.data, undefined);
    assert.match((await gql(app, "{ nope }", opts)).body.errors![0]!.message, /Cannot query field "nope"/);
    const many = await gql(app, "{ a: hello b: hello ...F } fragment F on Query { c: hello }", opts);
    assert.equal(many.body.errors![0]!.extensions!.code, "IL2020");
    assert.match(many.body.errors![0]!.message, /3 top-level fields; the most is 2/);
    assert.deepEqual((await gql(app, "{ a: hello b: hello __typename }", opts)).body.data, { a: { hello: "world" }, b: { hello: "world" }, __typename: "Query" });
    assert.match((await gql(app, "{ __schema { types { name } } }", opts)).body.errors![0]!.message, /introspection/i);
    assert.equal((await gql(app, "{ hello }", { ...opts, variables: [1] })).body.errors![0]!.extensions!.code, "IL1001");
    assert.equal((await app.request("/api/graphql", { method: "POST", json: {}, headers: { authorization: "Bearer reader" } })).status, 422, "a request without a query string");
    const open = makeApp();
    assert.ok((await gql(open, "{ __schema { queryType { name } } }", { token: "reader" })).body.data.__schema.queryType.name === "Query");
  });

  test("@browserlessapi/inferlo/graphql is a separate entry point, and graphql an optional peer dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(pkg.exports["./graphql"], { types: "./dist/graphql.d.ts", default: "./dist/graphql.js" });
    assert.equal(pkg.peerDependenciesMeta.graphql.optional, true);
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.doesNotMatch(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /graphql/, "the core never loads graphql");
  });
});

describe("GraphQL fields in describe() and OpenAPI", () => {
  test("describe() lists the endpoint's fields with their routes, and the fields each route serves", () => {
    const d = makeApp().describe();
    const endpoint = d.routes.find((r) => r.path === "/graphql")!;
    assert.deepEqual(endpoint.graphql, {
      query: { notes: "GET /notes", note: "GET /notes/:id", hello: "GET /hello", elsewhere: "GET /elsewhere" },
      mutation: { createNote: "POST /notes", deleteNote: "DELETE /notes/:id" },
    });
    assert.equal(endpoint.graphqlFields, undefined);
    assert.deepEqual(d.routes.find((r) => r.method === "GET" && r.path === "/notes")!.graphqlFields, ["Query.notes"]);
    assert.deepEqual(d.routes.find((r) => r.method === "POST" && r.path === "/notes")!.graphqlFields, ["Mutation.createNote"]);
    assert.deepEqual(d.routes.find((r) => r.method === "DELETE")!.graphqlFields, ["Mutation.deleteNote"]);
    // A route behind two names (or two endpoints) lists each field.
    const two = createApp({ db: memory(), models: [notes], auth: bearer(() => null), routes: [{ hello, graphql: graphqlRoute({ query: { hello, greeting: hello } }), other: graphqlRoute({ path: "/admin/graphql", query: { hi: hello } }) }] }).describe();
    assert.deepEqual(two.routes.find((r) => r.path === "/hello")!.graphqlFields, ["Query.hello", "Query.greeting", "Query.hi"]);
    assert.deepEqual(two.routes.find((r) => r.path === "/admin/graphql")!.graphql, { query: { hi: "GET /hello" }, mutation: {} });
    // Routes that are not fields have neither key.
    const plain = createApp({ db: memory(), routes: [{ hello }] }).describe();
    assert.equal("graphqlFields" in plain.routes[0]!, false);
    assert.equal("graphql" in plain.routes[0]!, false);
  });

  test("OpenAPI marks the endpoint with x-inferlo-graphql and field routes with x-inferlo-graphql-fields", () => {
    const doc = makeApp().openapi() as any;
    assert.deepEqual(doc.paths["/graphql"].post["x-inferlo-graphql"].mutation, { createNote: "POST /notes", deleteNote: "DELETE /notes/:id" });
    assert.equal(doc.paths["/graphql"].post["x-inferlo-graphql"].query.note, "GET /notes/:id");
    assert.deepEqual(doc.paths["/notes/{id}"].get["x-inferlo-graphql-fields"], ["Query.note"]);
    assert.deepEqual(doc.paths["/notes"].post["x-inferlo-graphql-fields"], ["Mutation.createNote"]);
    assert.equal(doc.paths["/hello"].get["x-inferlo-graphql"], undefined);
    assert.equal("x-inferlo-graphql-fields" in doc.paths["/graphql"].post, false);
  });

  test("a versioned endpoint lists the versioned paths of its routes", async () => {
    const { apiVersion } = await import("../src/index.ts");
    const app = createApp({ db: memory(), models: [notes], auth: bearer(() => null), routes: [apiVersion("v1", [{ listNotes, graphql: graphqlRoute({ query: { notes: listNotes } }) }])] });
    const d = app.describe();
    assert.deepEqual(d.routes.find((r) => r.path === "/v1/graphql")!.graphql, { query: { notes: "GET /v1/notes" }, mutation: {} });
    assert.deepEqual(d.routes.find((r) => r.path === "/v1/notes")!.graphqlFields, ["Query.notes"]);
  });
});
