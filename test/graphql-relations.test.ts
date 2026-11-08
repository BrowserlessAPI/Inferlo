// Relation fields between GraphQL object types (graphqlRoute({ relations })), batched per request.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { printSchema } from "graphql";
import { bearer, createApp, InferloError, memory, model, permissions, route, t, type AppUser } from "../src/index.ts";
import { graphqlContext, graphqlRoute, graphqlSchema, type GraphQLRelation } from "../src/graphql.ts";
import { readJson } from "../src/testing.ts";

const users = model("users", { name: t.string() });
const notes = model("notes", { title: t.string(), ownerId: t.ref("users"), reviewerId: t.ref("users").optional() });

const calls = { users: 0, notesByOwner: 0 };
const ids = t.array(t.uuid()).max(100);

const listNotes = route.get("/notes", { response: t.array(notes.row) }).handle(({ db }) => db.notes!.findMany({ orderBy: { title: "asc" } }));
const listUsers = route.get("/users/all", { response: t.array(users.row) }).handle(({ db }) => db.users!.findMany({ orderBy: { name: "asc" } }));
const usersByIds = route.get("/users", { query: t.object({ ids }), response: t.array(users.row) }).handle(({ db, query }) => {
  calls.users++;
  return db.users!.findMany({ where: { id: { in: query.ids } } });
});
const notesByOwners = route.get("/notes/by-owner", { query: t.object({ ownerIds: ids }), response: t.array(notes.row) }).handle(({ db, query }) => {
  calls.notesByOwner++;
  return db.notes!.findMany({ where: { ownerId: { in: query.ownerIds } }, orderBy: { title: "asc" } });
});
const secretUsers = route.get("/users/secret", { query: t.object({ ids }), response: t.array(users.row), permission: "users.read" }).handle(({ db, query }) => db.users!.findMany({ where: { id: { in: query.ids } } }));

const relations: GraphQLRelation[] = [
  { model: notes, field: "owner", route: usersByIds, from: "ownerId" },
  { model: notes, field: "reviewer", route: usersByIds, from: "reviewerId" },
  { model: users, field: "notes", route: notesByOwners, from: "id", to: "ownerId", arg: "ownerIds", many: true },
];

const people: Record<string, AppUser> = {
  admin: { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] },
  reader: { id: "22222222-2222-4222-8222-222222222222", roles: [] },
};

async function makeApp(options: { relations?: GraphQLRelation[]; maxFields?: number } = {}) {
  const graphql = graphqlRoute({ query: { notes: listNotes, users: listUsers }, relations: options.relations ?? relations, ...(options.maxFields ? { maxFields: options.maxFields } : {}) });
  const app = createApp({
    models: [users, notes],
    db: memory(),
    routes: [{ listNotes, listUsers, usersByIds, notesByOwners, secretUsers, graphql }],
    auth: bearer((token) => people[token] ?? null),
    permissions: permissions({ "users.read": ({ user }: { user: AppUser }) => (user.roles ?? []).includes("admin") }),
  });
  const ada = await app.db.users!.insert({ name: "Ada" });
  const bob = await app.db.users!.insert({ name: "Bob" });
  for (let i = 0; i < 30; i++) await app.db.notes!.insert({ title: `note ${String(i).padStart(2, "0")}`, ownerId: i % 2 ? bob.id : ada.id, ...(i === 0 ? { reviewerId: bob.id } : {}) });
  return { app, ada, bob };
}

type Answer = { data?: any; errors?: { message: string; path?: (string | number)[]; extensions?: { code?: string; status?: number } }[] };
const ask = async (app: Awaited<ReturnType<typeof makeApp>>["app"], query: string, token = "admin") => {
  const response = await app.request("/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
  return { status: response.status, body: await readJson<Answer>(response) };
};

describe("graphqlRoute({ relations })", () => {
  test("a list of rows resolves its relation with one route call", async () => {
    const { app, ada, bob } = await makeApp();
    calls.users = 0;
    const { status, body } = await ask(app, "{ notes { title owner { name } reviewer { name } } }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    assert.equal(body.data.notes.length, 30);
    assert.deepEqual(body.data.notes[0], { title: "note 00", owner: { name: "Ada" }, reviewer: { name: "Bob" } });
    assert.deepEqual(body.data.notes[1], { title: "note 01", owner: { name: "Bob" }, reviewer: null });
    // One call for owner and one for reviewer, not one per note.
    assert.equal(calls.users, 2);
    assert.ok(ada.id && bob.id);
  });

  test("many: true lists every matching row, nested relations batch per level", async () => {
    const { app } = await makeApp();
    calls.users = 0;
    calls.notesByOwner = 0;
    const { body } = await ask(app, "{ users { name notes { title owner { name } } } }");
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    assert.equal(body.data.users.length, 2);
    assert.equal(body.data.users[0].name, "Ada");
    assert.equal(body.data.users[0].notes.length, 15);
    assert.deepEqual(body.data.users[0].notes[0], { title: "note 00", owner: { name: "Ada" } });
    assert.ok(body.data.users[1].notes.every((n: { owner: { name: string } }) => n.owner.name === "Bob"));
    assert.equal(calls.notesByOwner, 1);
    assert.equal(calls.users, 1);
  });

  test("relation routes run as the caller, with their permissions", async () => {
    const { app } = await makeApp({ relations: [{ model: notes, field: "owner", route: secretUsers, from: "ownerId" }] });
    const allowed = await ask(app, "{ notes { owner { name } } }", "admin");
    assert.equal(allowed.body.errors, undefined);
    const denied = await ask(app, "{ notes { title owner { name } } }", "reader");
    assert.equal(denied.body.errors![0]!.extensions!.code, "IL3004");
    assert.deepEqual(denied.body.errors![0]!.path, ["notes", 0, "owner"]);
    // The rest of the answer is still there.
    assert.equal(denied.body.data.notes[0].title, "note 00");
    assert.equal(denied.body.data.notes[0].owner, null);
  });

  test("the schema has the relation fields, typed from the route's rows", () => {
    const sdl = printSchema(graphqlSchema({ query: { notes: listNotes, users: listUsers }, relations }));
    assert.match(sdl, /owner: UsersResult\n/);
    assert.match(sdl, /reviewer: UsersResult\n/);
    assert.match(sdl, /notes: \[NotesResult!\]!\n/);
  });

  test("relation fields count against maxFields", async () => {
    const { app } = await makeApp({ maxFields: 2 });
    const ok = await ask(app, "{ notes { owner { name } reviewer { name } } }");
    assert.equal(ok.body.errors, undefined);
    const many = await ask(app, "{ notes { owner { name } reviewer { name } a: owner { name } } }");
    assert.equal(many.body.errors![0]!.extensions!.code, "IL2021");
  });

  test("works with graphqlContext() in other GraphQL servers", async () => {
    const { app } = await makeApp();
    calls.users = 0;
    const { execute, parse } = await import("graphql");
    const schema = graphqlSchema({ query: { notes: listNotes }, relations: [relations[0]!] });
    const result = await execute({ schema, document: parse("{ notes { owner { name } } }"), contextValue: graphqlContext(app, new Request("http://localhost/graphql", { headers: { authorization: "Bearer reader" } })) });
    assert.equal(result.errors, undefined);
    assert.equal((result.data as any).notes.length, 30);
    assert.equal(calls.users, 1);
  });

  test("describe() and OpenAPI list the relation fields and their routes", async () => {
    const { app } = await makeApp();
    const map = app.describe();
    const endpoint = map.routes.find((r) => r.path === "/graphql")!;
    assert.deepEqual(endpoint.graphql!.relations, { "notes.owner": "GET /users", "notes.reviewer": "GET /users", "users.notes": "GET /notes/by-owner" });
    assert.deepEqual(map.routes.find((r) => r.path === "/users")!.graphqlFields, ["notes.owner", "notes.reviewer"]);
    const doc = app.openapi() as any;
    assert.deepEqual(doc.paths["/notes/by-owner"].get["x-inferlo-graphql-fields"], ["users.notes"]);
  });

  test("invalid relations raise IL6059 with a fix", () => {
    const code = (r: unknown, pattern: RegExp) =>
      assert.throws(
        () => graphqlSchema({ query: { notes: listNotes, users: listUsers }, relations: r as GraphQLRelation[] }),
        (e: InferloError) => e instanceof InferloError && e.code === "IL6059" && typeof e.fix === "string" && pattern.test(e.message),
      );
    code({}, /must be an array/);
    code([{ model: notes, field: "owner", route: usersByIds, from: "ownerId", extra: 1 }], /Unknown relation option "extra"/);
    code([{ model: {}, field: "owner", route: usersByIds, from: "ownerId" }], /model made with model/);
    code([{ model: notes, field: "title", route: usersByIds, from: "ownerId" }], /already has/);
    code([{ model: notes, field: "owner", route: usersByIds, from: "authorId" }], /needs from/);
    code([{ model: notes, field: "owner", route: listUsers, from: "ownerId" }], /no array argument "ids"/);
    code([{ model: notes, field: "owner", route: route.get("/x", { query: t.object({ ids }) }).handle(() => []), from: "ownerId" }], /must answer a list of rows/);
    code([{ model: notes, field: "owner", route: usersByIds, from: "ownerId", to: "userId" }], /no field "userId"/);
    code([{ model: notes, field: "owner", route: usersByIds, from: "ownerId", many: "yes" }], /many must be true or false/);
    code([relations[0], relations[0]], /defined twice/);
    // Rows that no field answers cannot get a relation.
    assert.throws(
      () => graphqlSchema({ query: { notes: listNotes }, relations: [relations[2]!] }),
      (e: InferloError) => e instanceof InferloError && e.code === "IL6059" && /no field answers/.test(e.message),
    );
  });
});
