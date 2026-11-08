// GraphQL Yoga serving graphqlSchema() with graphqlContext(app, request): fields run the app's routes as the caller.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createYoga } from "graphql-yoga";
import { bearer, createApp, InferloError, memory, model, notFound, permissions, route, t, type AppUser } from "../src/index.ts";
import { graphqlContext, graphqlSchema } from "../src/graphql.ts";

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
const notRegistered = route.get("/elsewhere").handle(() => ({}));

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
  query: { notes: listNotes, note: getNote, whoami, limited, elsewhere: notRegistered },
  mutation: { createNote, deleteNote },
});

type Answer = { data?: any; errors?: { message: string; path?: string[]; extensions?: { code?: string; status?: number } }[] };

async function gql(yoga: { fetch(request: Request): Promise<Response> | Response }, query: string, token?: string, variables?: unknown): Promise<Answer> {
  const response = await yoga.fetch(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
    }),
  );
  return (await response.json()) as Answer;
}

describe("graphqlContext() with GraphQL Yoga", () => {
  test("queries and mutations run the routes as the signed-in caller", async () => {
    const app = makeApp();
    const yoga = createYoga({ schema, context: ({ request }) => graphqlContext(app, request), logging: false });
    const created = await gql(yoga, 'mutation { createNote(title: "Hello", priority: high) { id title priority } }', "admin");
    assert.equal(created.errors, undefined);
    assert.equal(created.data.createNote.title, "Hello");
    assert.equal(created.data.createNote.priority, "high");
    const listed = await gql(yoga, "query($id: String!) { notes { title } note(id: $id) { title } whoami { id } }", "reader", { id: created.data.createNote.id });
    assert.equal(listed.errors, undefined);
    assert.deepEqual(listed.data, { notes: [{ title: "Hello" }], note: { title: "Hello" }, whoami: { id: users.reader!.id } });
    // The same rows as the REST routes.
    const rest = await app.request("/notes", { headers: { authorization: "Bearer admin" } });
    assert.equal(((await rest.json()) as unknown[]).length, 1);
  });

  test("each route keeps its auth, permissions and validation", async () => {
    const app = makeApp();
    const yoga = createYoga({ schema, context: ({ request }) => graphqlContext(app, request), logging: false });
    const anonymous = await gql(yoga, "{ whoami { id } }");
    assert.equal(anonymous.data, null);
    assert.equal(anonymous.errors![0]!.extensions!.code, "IL3001");
    const created = await gql(yoga, 'mutation { createNote(title: "Keep") { id } }', "admin");
    const denied = await gql(yoga, `mutation { deleteNote(id: "${created.data.createNote.id}") }`, "reader");
    assert.equal(denied.errors![0]!.extensions!.code, "IL3004");
    assert.deepEqual(denied.errors![0]!.path, ["deleteNote"]);
    const deleted = await gql(yoga, `mutation { deleteNote(id: "${created.data.createNote.id}") }`, "admin");
    assert.equal(deleted.errors, undefined);
    assert.equal(deleted.data.deleteNote, null);
    const tooLong = await gql(yoga, 'mutation { createNote(title: "This title is far too long for the route") { id } }', "admin");
    assert.equal(tooLong.errors![0]!.extensions!.code, "IL1001");
    assert.equal(tooLong.errors![0]!.extensions!.status, 422);
    const missing = await gql(yoga, '{ note(id: "33333333-3333-4333-8333-333333333333") { id } }', "admin");
    assert.equal(missing.errors![0]!.message, "Note not found");
    assert.equal(missing.errors![0]!.extensions!.status, 404);
  });

  test("a route that is not registered with the app answers Internal error with IL5011", async () => {
    const app = makeApp();
    const yoga = createYoga({ schema, context: ({ request }) => graphqlContext(app, request), logging: false });
    const answer = await gql(yoga, "{ elsewhere }", "admin");
    assert.equal(answer.errors![0]!.message, "Internal error.");
    assert.equal(answer.errors![0]!.extensions!.code, "IL5011");
  });

  test("the app's context sits next to the server's own context fields", async () => {
    const app = makeApp();
    const yoga = createYoga({ schema, context: ({ request }) => ({ ...graphqlContext(app, request), requestedAt: Date.now() }), logging: false });
    const answer = await gql(yoga, "{ whoami { id } }", "admin");
    assert.deepEqual(answer.data, { whoami: { id: users.admin!.id } });
  });

  test("without graphqlContext the fields answer IL6059", async () => {
    const yoga = createYoga({ schema, logging: false });
    const answer = await gql(yoga, "{ whoami { id } }", "admin");
    assert.equal(answer.errors![0]!.extensions!.code, "IL6059");
    assert.match(answer.errors![0]!.message, /graphqlContext/);
  });

  test("invalid arguments raise IL6060", () => {
    const app = makeApp();
    const request = new Request("http://localhost/graphql");
    const code = (fn: () => unknown) => assert.throws(fn, (e: InferloError) => e instanceof InferloError && e.code === "IL6060" && typeof e.fix === "string");
    code(() => graphqlContext(undefined as never, request));
    code(() => graphqlContext({} as never, request));
    code(() => graphqlContext(app, undefined as never));
    code(() => graphqlContext(app, "Bearer admin" as never));
  });
});

describe("graphqlContext() with a Node.js request", () => {
  const app = makeApp();
  // In Node.js, Yoga passes the node:http request as req; per-IP rate limits use its socket address.
  const yoga = createYoga<{ req: import("node:http").IncomingMessage }>({ schema, context: ({ req }) => graphqlContext(app, req), logging: false });
  let server: Server;
  let url = "";
  before(async () => {
    server = createServer(yoga);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = async (query: string, token?: string): Promise<Answer> => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }) });
    return (await response.json()) as Answer;
  };

  test("credentials and the client address come from the Node.js request", async () => {
    assert.deepEqual((await post("{ whoami { id } }", "reader")).data, { whoami: { id: users.reader!.id } });
    assert.equal((await post("{ whoami { id } }")).errors![0]!.extensions!.code, "IL3001");
    assert.deepEqual((await post("{ limited { ok } }")).data, { limited: { ok: true } });
    const second = await post("{ limited { ok } }");
    assert.equal(second.errors![0]!.extensions!.status, 429);
  });
});
