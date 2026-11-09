import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp, createDb, InferloError, memory, mockProvider, model, route, t, type Adapter, type Db } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { planMigration } from "../src/db/migrate.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";
import { readJson } from "../src/testing.ts";

// t.vector(n) fields and db.<table>.search({ vector, limit }): nearest rows by cosine distance, on memory() and on
// Postgres with pgvector. The Postgres runs need INFERLO_TEST_DATABASE_URL and INFERLO_TEST_PGVECTOR=1 (a server with
// the pgvector extension available); CI runs them on the oldest supported and latest pgvector.

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const PGVECTOR = PG_URL && process.env.INFERLO_TEST_PGVECTOR === "1";

const Doc = model("vec_docs", {
  title: t.string().max(100),
  ownerId: t.string().max(40),
  embedding: t.vector(3).optional().index(),
});
const Pair = model("vec_pairs", { a: t.vector(2), b: t.vector(2).optional() });
const Org = model("vec_org_docs", { title: t.string().max(100), embedding: t.vector(2) }, { tenant: true });
const models = [Doc, Pair, Org] as const;

const adapters: [string, () => Adapter][] = [["memory", () => memory()]];
if (PGVECTOR) adapters.push(["postgres", () => postgres({ url: PG_URL })]);
if (PGVECTOR) adapters.push(["postgres.js", () => postgresJsAdapter(PG_URL!)]);

describe("t.vector()", () => {
  test("validates the number of dimensions and finite numbers, with a JSON Schema", () => {
    const v = t.vector(3);
    assert.deepEqual(v.parse([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
    const short = v.safeParse([1, 2]);
    assert.equal(short.ok, false);
    assert.equal(!short.ok && short.issues[0]!.code, "invalid_dimensions");
    assert.equal(v.safeParse([1, 2, Number.NaN]).ok, false);
    assert.equal(v.safeParse([1, "2", 3]).ok, false);
    assert.equal(v.safeParse("1,2,3").ok, false);
    assert.deepEqual(v.toJSONSchema(), { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 });
    for (const bad of [0, 1.5, 16001, Number.NaN]) {
      assert.throws(() => t.vector(bad), (e: InferloError) => e.code === "IL1005");
    }
  });

  test("Postgres columns are vector(n), .index() is an HNSW index for cosine distance, and migrations enable pgvector", () => {
    const plan = planMigration([Doc]);
    assert.equal(plan.statements[0], "CREATE EXTENSION IF NOT EXISTS vector");
    assert.match(plan.statements[1]!, /"embedding" vector\(3\)/);
    assert.ok(plan.statements.includes('CREATE INDEX IF NOT EXISTS "vec_docs_embedding_idx" ON "vec_docs" USING hnsw ("embedding" vector_cosine_ops)'));
    // Adding a vector column to an existing table enables pgvector too; tables without vectors do not.
    const Plain = model("vec_docs", { title: t.string().max(100), ownerId: t.string().max(40) });
    const added = planMigration([Doc], planMigration([Plain]).snapshot);
    assert.equal(added.statements[0], "CREATE EXTENSION IF NOT EXISTS vector");
    assert.equal(planMigration([Plain]).statements.some((s) => s.includes("EXTENSION")), false);
  });

  test("describe() lists the dimensions", () => {
    const app = createApp({ models: [Doc], db: memory(), logger: { info() {}, error() {} } });
    const field = app.describe().models.find((m: { name: string }) => m.name === "vec_docs")!.fields.embedding;
    assert.equal(field!.type, "vector");
    assert.equal(field!.dimensions, 3);
  });
});

for (const [name, make] of adapters) {
  describe(`db.search (${name})`, () => {
    const db = createDb(models, make());

    before(async () => {
      if (name !== "memory") await db.$sql('DROP TABLE IF EXISTS "vec_docs", "vec_pairs", "vec_org_docs" CASCADE');
      await db.$sync();
      await db.vec_docs.insertMany([
        { title: "north", ownerId: "ann", embedding: [0, 1, 0] },
        { title: "north-east", ownerId: "ann", embedding: [1, 1, 0] },
        { title: "east", ownerId: "ann", embedding: [1, 0, 0] },
        { title: "south", ownerId: "ben", embedding: [0, -1, 0] },
        { title: "no vector", ownerId: "ann" },
      ]);
    });
    after(async () => {
      await db.$close();
    });

    test("returns the closest rows first with their cosine distance, and stores vectors as numbers", async () => {
      const hits = await db.vec_docs.search({ vector: [0, 2, 0], limit: 3 });
      assert.deepEqual(hits.map((h) => h.row.title), ["north", "north-east", "east"]);
      assert.ok(Math.abs(hits[0]!.distance) < 1e-6);
      assert.ok(Math.abs(hits[1]!.distance - (1 - Math.SQRT1_2)) < 1e-6);
      assert.ok(Math.abs(hits[2]!.distance - 1) < 1e-6);
      assert.deepEqual(hits[0]!.row.embedding, [0, 1, 0]);
      assert.ok(hits[0]!.row.createdAt instanceof Date);
      const stored = await db.vec_docs.findOne({ title: "north-east" });
      assert.deepEqual(stored!.embedding, [1, 1, 0]);
    });

    test("where filters the rows, rows without a vector are left out, and limit defaults to 10", async () => {
      const mine = await db.vec_docs.search({ vector: [0, -1, 0], where: { ownerId: "ann" } });
      assert.deepEqual(mine.map((h) => h.row.title), ["east", "north-east", "north"]);
      assert.ok(Math.abs(mine.at(-1)!.distance - 2) < 1e-6);
      const all = await db.vec_docs.search({ vector: [1, 0, 0] });
      assert.equal(all.length, 4);
    });

    test("updates work, and where finds rows without a vector", async () => {
      const row = await db.vec_docs.findOne({ title: "south" });
      const updated = await db.vec_docs.update(row!.id, { embedding: [0, 0, 1] });
      assert.deepEqual(updated.embedding, [0, 0, 1]);
      const hits = await db.vec_docs.search({ vector: [0, 0, 5], limit: 1 });
      assert.equal(hits[0]!.row.title, "south");
      assert.deepEqual((await db.vec_docs.findMany({ where: { embedding: { isNull: true } } })).map((r) => r.title), ["no vector"]);
    });

    test("a model with several vector fields needs field; wrong fields and vectors raise IL4030", async () => {
      await db.vec_pairs.insert({ a: [1, 0], b: [0, 1] });
      await db.vec_pairs.insert({ a: [0, 1] });
      assert.equal((await db.vec_pairs.search({ field: "b", vector: [0, 1] })).length, 1);
      assert.equal((await db.vec_pairs.search({ field: "a", vector: [0, 1], limit: 1 }))[0]!.row.b, null);
      const code = (e: InferloError) => e.code === "IL4030";
      await assert.rejects(db.vec_pairs.search({ vector: [0, 1] }), (e: InferloError) => code(e) && /several/.test(e.message));
      await assert.rejects(db.vec_pairs.search({ field: "c" as never, vector: [0, 1] }), code);
      await assert.rejects(db.vec_docs.search({ vector: [1, 0] }), (e: InferloError) => code(e) && /3 finite numbers/.test(e.message));
      await assert.rejects(db.vec_docs.search({ vector: [1, 0, Number.NaN] }), code);
      await assert.rejects(db.vec_docs.search({ field: "title" as never, vector: [1, 0, 0] }), code);
      await assert.rejects(db.vec_docs.insert({ title: "bad", ownerId: "x", embedding: [1, 2] }), (e: InferloError) => e.code === "IL1001");
    });

    test("tenant-scoped tables only search the tenant's rows", async () => {
      await db.$tenant("acme").vec_org_docs.insert({ title: "acme", embedding: [1, 0] });
      await db.$tenant("globex").vec_org_docs.insert({ title: "globex", embedding: [1, 0] });
      const hits = await db.$tenant("acme").vec_org_docs.search({ vector: [1, 0] });
      assert.deepEqual(hits.map((h) => h.row.title), ["acme"]);
      await assert.rejects(db.vec_org_docs.search({ vector: [1, 0] }), (e: InferloError) => e.code === "IL4027");
    });
  });
}

describe("search with ai.embed in a route", () => {
  test("embeds the question and answers with the closest documents of the signed-in user", async () => {
    const Note = model("vec_notes", { text: t.text(), ownerId: t.string().max(40), embedding: t.vector(8) });
    const ask = route.get("/search", { query: t.object({ q: t.string().max(200) }) }).handle(async ({ query, ai, db, user }) => {
      const { embeddings } = await ai.embed({ model: "embed", input: query.q, for: user.id });
      const hits = await (db as unknown as Db<readonly [typeof Note]>).vec_notes.search({ vector: embeddings[0]!, where: { ownerId: user.id }, limit: 2 });
      return hits.map((h) => ({ text: h.row.text, distance: Number(h.distance.toFixed(4)) }));
    });
    const app = createApp({
      models: [Note],
      routes: [{ ask }],
      db: memory(),
      auth: { resolve: () => null },
      ai: { providers: { mock: mockProvider({ respond: () => "" }) }, models: { embed: "mock:e" } },
      logger: { info() {}, error() {} },
    });
    for (const [text, ownerId] of [["buy milk", "ann"], ["buy bread", "ann"], ["quarterly report", "ann"], ["buy milk", "ben"]] as const) {
      const { embeddings } = await app.ai.embed({ model: "embed", input: text });
      await app.db.vec_notes.insert({ text, ownerId, embedding: embeddings[0]! });
    }
    const out = await readJson(await app.request("/search?q=buy%20milk", { as: { id: "ann", roles: [] } }), 200);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { text: "buy milk", distance: 0 });
  });
});
