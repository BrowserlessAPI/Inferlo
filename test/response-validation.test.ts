// Response validation (createApp({ validateResponses })): a handler's JSON answer is checked against the route's
// response schema outside production, so a missing, wrong or leaked field shows up while developing.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createApp, InferloError, memory, model, route, setEnv, t } from "../src/index.ts";

const Note = t.object({ id: t.int(), title: t.string(), createdAt: t.date() });

function capture() {
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  return { lines, logger: { info() {}, error: (message: string, _data?: unknown, fields?: Record<string, unknown>) => void lines.push({ message, fields }) } };
}

function routes(answer: () => unknown) {
  return [
    {
      note: route.get("/note", { auth: "public", response: Note }).handle(() => answer()),
      plain: route.get("/plain", { auth: "public" }).handle(() => ({ anything: true })),
      notes: route.get("/notes", { auth: "public", response: t.array(Note) }).handle(() => [answer()]),
      created: route.post("/notes", { auth: "public", response: Note }).handle(({ status }) => {
        status(201);
        return answer();
      }),
      raw: route.get("/raw", { auth: "public", response: Note }).handle(() => new Response("not json")),
      empty: route.delete("/note", { auth: "public", response: Note }).handle(() => undefined),
    },
  ];
}

const good = () => ({ id: 1, title: "Hello", createdAt: new Date("2026-11-07T10:00:00Z") });

afterEach(() => setEnv(undefined));

describe("response validation", () => {
  test("a matching answer is sent unchanged and nothing is logged", async () => {
    const { lines, logger } = capture();
    const app = createApp({ routes: routes(good), logger, validateResponses: "warn" });
    const res = await app.request("/note");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 1, title: "Hello", createdAt: "2026-11-07T10:00:00.000Z" });
    assert.equal((await app.request("/notes")).status, 200);
    assert.equal((await app.request("/notes", { method: "POST" })).status, 201);
    assert.deepEqual(lines, []);
  });

  test('"warn" sends the answer and logs IL2016 with the route and the fields, once per route', async () => {
    const { lines, logger } = capture();
    const app = createApp({ routes: routes(() => ({ id: "1", title: "Hello", createdAt: "yesterday", passwordHash: "x" })), logger, validateResponses: "warn" });
    const res = await app.request("/note");
    assert.equal(res.status, 200, "the answer is still sent");
    assert.equal((await res.json()).passwordHash, "x");
    await app.request("/note");
    assert.equal(lines.length, 1, "logged once per route");
    const [line] = lines;
    assert.match(line!.message, /^IL2016 GET \/note: the response does not match the route's response schema/);
    assert.match(line!.message, /id: /);
    assert.match(line!.message, /createdAt: /);
    assert.match(line!.message, /passwordHash/);
    assert.ok(!line!.message.includes('"x"'), "values are never logged");
    await app.request("/notes");
    assert.equal(lines.length, 2);
    assert.match(lines[1]!.message, /GET \/notes: .*0\.id: /);
  });

  test('"error" answers 500 IL2016 with the fields (not the values), for tests', async () => {
    const { logger } = capture();
    const app = createApp({ routes: routes(() => ({ id: 1, title: 42, createdAt: new Date(), secret: "s3cret" })), logger, validateResponses: "error" });
    const res = await app.request("/note");
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "IL2016");
    assert.match(body.error.message, /title/);
    assert.deepEqual(body.error.details.map((i: { path: unknown[] }) => i.path.join(".")).sort(), ["secret", "title"]);
    assert.ok(!JSON.stringify(body).includes("s3cret"));
  });

  test("routes without a response schema, Response objects and empty answers are not checked", async () => {
    const { lines, logger } = capture();
    const app = createApp({ routes: routes(() => ({ wrong: true })), logger, validateResponses: "error" });
    assert.equal((await app.request("/plain")).status, 200);
    assert.equal(await (await app.request("/raw")).text(), "not json");
    assert.equal((await app.request("/note", { method: "DELETE" })).status, 204);
    assert.deepEqual(lines, []);
  });

  test("error answers are not checked against the response schema", async () => {
    const app = createApp({
      routes: [{ missing: route.get("/missing", { auth: "public", response: Note }).handle(() => { throw new InferloError("IL4001", "Not found.", { status: 404 }); }) }],
      logger: capture().logger,
      validateResponses: "error",
    });
    const res = await app.request("/missing");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "IL4001");
  });

  test("on by default (\"warn\") outside production, off in production; false turns it off", async () => {
    const bad = () => ({ id: "x" });
    setEnv({ INFERLO_ENV: undefined, NODE_ENV: "test" });
    const dev = capture();
    await createApp({ routes: routes(bad), logger: dev.logger }).request("/note");
    assert.equal(dev.lines.length, 1);

    setEnv({ INFERLO_ENV: undefined, NODE_ENV: "production" });
    const prod = capture();
    const res = await createApp({ routes: routes(bad), logger: prod.logger }).request("/note");
    assert.equal(res.status, 200);
    assert.equal(prod.lines.length, 0);

    setEnv({ INFERLO_ENV: "production", NODE_ENV: "development" });
    const inferloEnv = capture();
    await createApp({ routes: routes(bad), logger: inferloEnv.logger }).request("/note");
    assert.equal(inferloEnv.lines.length, 0, "INFERLO_ENV wins over NODE_ENV");

    setEnv({ INFERLO_ENV: undefined, NODE_ENV: "development" });
    const off = capture();
    await createApp({ routes: routes(bad), logger: off.logger, validateResponses: false }).request("/note");
    assert.equal(off.lines.length, 0);
  });

  test("an invalid option fails at startup with IL6040", () => {
    for (const value of ["yes", true, 1]) {
      assert.throws(() => createApp({ routes: [], validateResponses: value as never }), (e: unknown) => e instanceof InferloError && e.code === "IL6040");
    }
  });

  test("cached routes are checked before the answer is cached", async () => {
    const { lines, logger } = capture();
    const app = createApp({
      routes: [{ c: route.get("/c", { auth: "public", response: Note, cache: { ttlMs: 60_000, by: "public" } }).handle(() => ({ id: 1 })) }],
      logger,
      validateResponses: "error",
    });
    assert.equal((await app.request("/c")).status, 500);
    assert.equal((await app.request("/c")).status, 500, "nothing was cached");
    assert.deepEqual(lines.filter((l) => l.message.startsWith("IL2016")), []);
  });
});

describe("response validation with model rows", () => {
  // Regression: the fields Inferlo sets (id, createdAt, updatedAt, tenantId) are refused in input, and the same
  // rule made every answer of a route with response: Model.row fail the check (IL2016, or 500 with "error").
  const Ticket = model("tickets", { title: t.string().max(50) });
  const Shared = model("shared_notes", { title: t.string() }, { tenant: true });

  test("a row, a list of rows and a tenant-scoped row match their row schemas", async () => {
    const { lines, logger } = capture();
    const app = createApp({
      models: [Ticket, Shared],
      db: memory(),
      logger,
      validateResponses: "error",
      auth: { resolve: () => ({ id: "u1", tenantId: "acme" }) },
      routes: [
        {
          create: route.post("/tickets", { body: Ticket.create, response: Ticket.row }).handle(({ db, body }) => db.tickets!.insert(body)),
          list: route.get("/tickets", { response: t.array(Ticket.row) }).handle(({ db }) => db.tickets!.findMany()),
          shared: route.post("/shared", { body: Shared.create, response: Shared.row }).handle(({ db, body }) => db.shared_notes!.insert(body)),
        },
      ],
    });
    const created = await app.request("/tickets", { method: "POST", json: { title: "Broken login" } });
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal(((await created.json()) as { title: string }).title, "Broken login");
    assert.equal((await app.request("/tickets")).status, 200);
    const shared = await app.request("/shared", { method: "POST", json: { title: "Plan" } });
    assert.equal(shared.status, 200, await shared.clone().text());
    assert.equal(((await shared.json()) as { tenantId: string }).tenantId, "acme");
    assert.deepEqual(lines, []);
  });

  test("the fields Inferlo sets are still refused in request bodies", async () => {
    const app = createApp({
      models: [Ticket],
      db: memory(),
      routes: [{ create: route.post("/tickets", { auth: "public", body: Ticket.row }).handle(() => ({ ok: true })) }],
    });
    const res = await app.request("/tickets", { method: "POST", json: { id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff", title: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /set by the framework/);
  });
});

test("null in an optional field of a row is accepted in answers, and still refused in request bodies", async () => {
  const Doc = model("docs", { title: t.string(), note: t.string().optional(), meta: t.json().optional() });
  const { lines, logger } = capture();
  const app = createApp({
    models: [Doc],
    db: memory(),
    logger,
    validateResponses: "error",
    routes: [
      {
        create: route.post("/docs", { auth: "public", body: Doc.create, response: Doc.row }).handle(({ db, body }) => db.docs!.insert(body)),
      },
    ],
  });
  const created = await app.request("/docs", { method: "POST", json: { title: "Plan" } });
  assert.equal(created.status, 200, await created.clone().text());
  assert.deepEqual(lines, []);
  const refused = await app.request("/docs", { method: "POST", json: { title: "Plan", note: null } });
  assert.equal(refused.status, 422);
});
