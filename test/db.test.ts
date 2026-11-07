import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createDb, InferloError, memory, type Adapter } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";
import { models } from "./helpers.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;

const adapters: [string, () => Adapter][] = [["memory", () => memory()]];
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);
if (PG_URL) adapters.push(["postgres.js", () => postgresJsAdapter(PG_URL)]);

for (const [name, make] of adapters) {
  describe(`db (${name})`, () => {
    const adapter = make();
    const db = createDb(models, adapter);

    before(async () => {
      if (name !== "memory") {
        await db.$sql('DROP TABLE IF EXISTS "posts", "authors" CASCADE');
      }
      await db.$sync();
    });
    after(async () => {
      await db.$close();
    });

    test("insert applies defaults and returns typed rows", async () => {
      const a = await db.authors.insert({ name: "Asha", email: "asha@example.com" });
      const p = await db.posts.insert({ title: "Hi", body: "There", authorId: a.id, tags: ["x"], meta: { source: "web" } });
      assert.equal(p.views, 0);
      assert.equal(p.published, false);
      assert.deepEqual(p.tags, ["x"]);
      assert.deepEqual(p.meta, { source: "web" });
      assert.equal(p.kind, "note");
      assert.equal(p.rating, null);
      assert.ok(p.createdAt instanceof Date);
      const again = await db.posts.get(p.id);
      assert.equal(again.title, "Hi");
      assert.deepEqual(again.tags, ["x"]);
    });

    test("validation runs on insert and update", async () => {
      const a = await db.authors.insert({ name: "B", email: "b@example.com" });
      await assert.rejects(db.posts.insert({ title: "", body: "x", authorId: a.id }), /IL1001|at least 1/);
      const p = await db.posts.insert({ title: "ok", body: "x", authorId: a.id });
      await assert.rejects(db.posts.update(p.id, { views: 1.5 } as never), /whole number/);
      await assert.rejects(db.posts.update(p.id, { id: "x" } as never), /Unknown field|unknown/i);
    });

    test("unique fields raise IL4004 (409)", async () => {
      await db.authors.insert({ name: "C", email: "c@example.com" });
      await assert.rejects(db.authors.insert({ name: "C2", email: "c@example.com" }), (e: unknown) => e instanceof InferloError && e.code === "IL4004" && e.status === 409);
    });

    test("findMany with operators, order, limit and offset", async () => {
      const a = await db.authors.insert({ name: "D", email: "d@example.com" });
      for (let i = 1; i <= 5; i++) await db.posts.insert({ title: `n${i}`, body: "b", authorId: a.id, kind: i % 2 ? "article" : "note", rating: i });
      const top = await db.posts.findMany({ where: { authorId: a.id, rating: { gte: 3 } }, orderBy: { rating: "desc" } });
      assert.deepEqual(top.map((p) => p.rating), [5, 4, 3]);
      const page = await db.posts.findMany({ where: { authorId: a.id }, orderBy: [["rating", "asc"]], limit: 2, offset: 1 });
      assert.deepEqual(page.map((p) => p.rating), [2, 3]);
      const some = await db.posts.findMany({ where: { authorId: a.id, title: { in: ["n1", "n4"] } } });
      assert.equal(some.length, 2);
      const like = await db.posts.findMany({ where: { authorId: a.id, title: { like: "n%" }, kind: "note" } });
      assert.equal(like.length, 2);
      assert.equal(await db.posts.count({ authorId: a.id, kind: "article" }), 3);
      const none = await db.posts.findMany({ where: { authorId: a.id, title: { in: [] } } });
      assert.equal(none.length, 0);
      const nulls = await db.posts.findMany({ where: { authorId: a.id, publishedAt: null } });
      assert.equal(nulls.length, 5);
    });

    test("unknown fields in where give a did-you-mean error", async () => {
      await assert.rejects(db.posts.findMany({ where: { titel: "x" } as never }), (e: unknown) => e instanceof InferloError && e.code === "IL4003" && /Did you mean "title"/.test(e.message));
      await assert.rejects(db.posts.findMany({ where: { title: { equals: "x" } } as never }), /Unknown operator "equals"/);
    });

    test("update, updateMany, delete, deleteMany", async () => {
      const a = await db.authors.insert({ name: "E", email: "e@example.com" });
      const p = await db.posts.insert({ title: "t", body: "b", authorId: a.id });
      const u = await db.posts.update(p.id, { published: true, publishedAt: new Date("2026-01-01T00:00:00Z") });
      assert.equal(u.published, true);
      assert.ok(u.updatedAt.getTime() >= p.updatedAt.getTime());
      assert.equal(u.publishedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
      await assert.rejects(db.posts.update("33333333-3333-4333-8333-333333333333", { views: 1 }), /IL4001|not found/);
      await db.posts.insert({ title: "t2", body: "b", authorId: a.id });
      const many = await db.posts.updateMany({ authorId: a.id }, { views: 7 });
      assert.equal(many.length, 2);
      assert.equal(await db.posts.delete(p.id), true);
      assert.equal(await db.posts.delete(p.id), false);
      await assert.rejects(db.posts.deleteMany({}), /IL4007|needs a where/);
      assert.equal(await db.posts.deleteMany({ authorId: a.id }), 1);
    });

    test("unknown table gives IL4002", () => {
      assert.throws(() => (db as any).post, /db.post does not exist. Did you mean "posts"/);
    });

    if (name !== "memory") {
      test("in and notIn compare JSON fields as JSON", async () => {
        const a = await db.authors.insert({ name: "Jo", email: "jo-json@example.com" });
        await db.posts.insert({ title: "J1", body: "x", authorId: a.id, tags: ["json-in-a"] });
        await db.posts.insert({ title: "J2", body: "x", authorId: a.id, tags: ["json-in-b", "json-in-c"] });
        const found = await db.posts.findMany({ where: { authorId: a.id, tags: { in: [["json-in-a"], ["json-in-x"]] } } });
        assert.deepEqual(found.map((p) => p.title), ["J1"]);
        const others = await db.posts.findMany({ where: { authorId: a.id, tags: { notIn: [["json-in-a"]] } } });
        assert.deepEqual(others.map((p) => p.title), ["J2"]);
        assert.equal((await db.posts.findMany({ where: { authorId: a.id, tags: { eq: ["json-in-b", "json-in-c"] } } })).length, 1);
      });

      test("sync is idempotent and adds new columns", async () => {
        const again = await db.$sync({ dryRun: true });
        assert.ok(again.every((s) => s.startsWith("CREATE") && s.includes("IF NOT EXISTS")));
        const { model, t } = await import("../src/index.ts");
        const Extended = model("authors", { name: t.string().max(80), email: t.email().unique(), bio: t.text().optional() });
        const statements = await createDb([Extended], adapter).$sync();
        assert.ok(statements.some((s) => s.includes('ADD COLUMN "bio" text')));
      });

      test("transactions roll back on error", async () => {
        await assert.rejects(
          db.$transaction(async (tx: any) => {
            await tx.authors.insert({ name: "T", email: "tx@example.com" });
            throw new Error("rollback");
          }),
          /rollback/,
        );
        assert.equal(await db.authors.count({ email: "tx@example.com" }), 0);
      });

      test("foreign keys cascade", async () => {
        const a = await db.authors.insert({ name: "F", email: "f@example.com" });
        await db.posts.insert({ title: "t", body: "b", authorId: a.id });
        await db.authors.delete(a.id);
        assert.equal(await db.posts.count({ authorId: a.id }), 0);
      });
    }
  });
}
