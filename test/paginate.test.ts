import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createDb, InferloError, memory, model, t, type Adapter, type Row } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";
import { sqlite } from "../src/db/sqlite.ts";
import { MYSQL_URL, mysqlAdapter } from "./mysql-adapter.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;

const Owner = model("pg_owners", { name: t.string().max(80) });
const Item = model("pg_items", {
  title: t.string().max(80),
  score: t.int(),
  status: t.enum(["open", "closed"]).default("open"),
  dueAt: t.date().optional(),
  meta: t.json<{ a?: number }>().optional(),
  ownerId: t.ref("pg_owners", { onDelete: "cascade" }),
});
const models = [Owner, Item] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>() => void 0 as unknown as T;

const adapters: [string, () => Adapter][] = [["memory", () => memory()], ["sqlite", () => sqlite()]];
if (MYSQL_URL) adapters.push(["mysql", () => mysqlAdapter()]);
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);
if (PG_URL) adapters.push(["postgres.js", () => postgresJsAdapter(PG_URL)]);

for (const [name, make] of adapters) {
  describe(`paginate (${name})`, () => {
    const db = createDb(models, make());
    let owner: Row<typeof Owner>;
    const all: Row<typeof Item>[] = [];

    before(async () => {
      if (name.startsWith("postgres")) await db.$sql('DROP TABLE IF EXISTS "pg_items", "pg_owners" CASCADE');
      await db.$sync();
      owner = await db.pg_owners.insert({ name: "Ann" });
      // Scores repeat, so pages must break ties by id without skipping or repeating rows.
      for (let i = 0; i < 23; i++) {
        all.push(await db.pg_items.insert({ title: `I${String(i).padStart(2, "0")}`, score: i % 4, status: i % 5 === 0 ? "closed" : "open", ownerId: owner.id }));
      }
    });
    after(async () => {
      await db.$close();
    });

    const collect = async (options: Parameters<typeof db.pg_items.paginate>[0]) => {
      const seen: Row<typeof Item>[] = [];
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      do {
        const page: { items: Row<typeof Item>[]; nextCursor: string | null } = await db.pg_items.paginate({ ...options, cursor });
        seen.push(...page.items);
        cursor = page.nextCursor;
        assert.ok(++pages < 50, "pagination ends");
      } while (cursor);
      return { seen, pages };
    };

    test("walks every row once in createdAt order by default", async () => {
      const first = await db.pg_items.paginate({ limit: 10 });
      assert.equal(first.items.length, 10);
      assert.equal(typeof first.nextCursor, "string");
      const typed: Row<typeof Item>[] = first.items;
      void typed;
      const { seen, pages } = await collect({ limit: 10 });
      assert.equal(pages, 3);
      // Rows created in the same millisecond are ordered by id.
      const expected = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
      assert.deepEqual(seen.map((r) => r.id), expected.map((r) => r.id));
    });

    test("orders by a field with ties, both directions, with where", async () => {
      const sortedBy = (dir: 1 | -1) => (a: Row<typeof Item>, b: Row<typeof Item>) => (a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) * dir;
      const asc = await collect({ orderBy: { score: "asc" }, limit: 4 });
      assert.deepEqual(asc.seen.map((r) => r.id), [...all].sort(sortedBy(1)).map((r) => r.id));
      const desc = await collect({ orderBy: [["score", "desc"]], limit: 3 });
      assert.deepEqual(desc.seen.map((r) => r.id), [...all].sort(sortedBy(-1)).map((r) => r.id));
      const open = await collect({ where: { status: "open" }, orderBy: { score: "desc" }, limit: 5 });
      assert.deepEqual(open.seen.map((r) => r.id), all.filter((r) => r.status === "open").sort(sortedBy(-1)).map((r) => r.id));
    });

    test("orders by id or by createdAt descending", async () => {
      const byId = await collect({ orderBy: { id: "asc" }, limit: 7 });
      assert.deepEqual(byId.seen.map((r) => r.id), all.map((r) => r.id).sort());
      const newest = await collect({ orderBy: { createdAt: "desc" }, limit: 6 });
      assert.deepEqual(
        newest.seen.map((r) => r.id),
        [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)).map((r) => r.id),
      );
    });

    test("the last page has nextCursor null, and an exact fit does not add an empty page", async () => {
      const page = await db.pg_items.paginate({ limit: 23 });
      assert.equal(page.items.length, 23);
      assert.equal(page.nextCursor, null);
      const empty = await db.pg_items.paginate({ where: { title: "none" } });
      assert.deepEqual(empty, { items: [], nextCursor: null });
    });

    test("include loads relations for the page", async () => {
      const page = await db.pg_items.paginate({ limit: 2, include: { owner: true } });
      assert.equal(page.items[0]!.owner.name, "Ann");
      assertType<Equal<(typeof page.items)[number]["owner"], Row<typeof Owner>>>();
    });

    test("a cursor from another order or a tampered cursor raises IL4024 with status 400", async () => {
      const page = await db.pg_items.paginate({ orderBy: { score: "asc" }, limit: 2 });
      const isBadCursor = (e: unknown) => e instanceof InferloError && e.code === "IL4024" && e.status === 400 && e.expose;
      await assert.rejects(db.pg_items.paginate({ orderBy: { title: "asc" }, cursor: page.nextCursor! }), isBadCursor);
      await assert.rejects(db.pg_items.paginate({ orderBy: { score: "desc" }, cursor: page.nextCursor! }), isBadCursor);
      await assert.rejects(db.pg_items.paginate({ cursor: "not-a-cursor" }), isBadCursor);
      const forged = Buffer.from(JSON.stringify({ f: "score", d: "asc", v: "x' OR 1=1", id: "nope" })).toString("base64url");
      await assert.rejects(db.pg_items.paginate({ orderBy: { score: "asc" }, cursor: forged }), isBadCursor);
    });

    test("invalid options raise IL4025", async () => {
      const isBadOptions = (e: unknown) => e instanceof InferloError && e.code === "IL4025";
      await assert.rejects(db.pg_items.paginate({ orderBy: { score: "asc", title: "asc" } }), isBadOptions);
      await assert.rejects(db.pg_items.paginate({ orderBy: { dueAt: "asc" } }), isBadOptions);
      await assert.rejects(db.pg_items.paginate({ orderBy: { meta: "asc" } as never }), isBadOptions);
      await assert.rejects(db.pg_items.paginate({ offset: 10 } as never), isBadOptions);
      await assert.rejects(db.pg_items.paginate({ orderBy: { nope: "asc" } as never }), (e: unknown) => e instanceof InferloError && e.code === "IL4003");
    });

    test("rows added before the cursor do not shift later pages", async () => {
      const first = await db.pg_items.paginate({ orderBy: { createdAt: "desc" }, limit: 5 });
      // A new row is newest, so it belongs before the first page; offset pagination would repeat a row here.
      const extra = await db.pg_items.insert({ title: "new", score: 9, ownerId: owner.id });
      const second = await db.pg_items.paginate({ orderBy: { createdAt: "desc" }, limit: 5, cursor: first.nextCursor });
      const ids = new Set(first.items.map((r) => r.id));
      assert.ok(second.items.every((r) => !ids.has(r.id) && r.id !== extra.id));
      await db.pg_items.delete(extra.id);
    });
  });
}
