// Drizzle ORM next to Inferlo on one Postgres database: one pg pool, shared transactions, and migrations that
// leave each other's tables alone. Needs INFERLO_TEST_DATABASE_URL; the memory() checks run everywhere.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { createApp, InferloError, memory, model, planMigration, route, t, type PgClient } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const quiet = { info: () => {}, error: () => {} };

// A table the existing Drizzle app owns, and an Inferlo model added next to it.
const invoices = pgTable(`dz_invoices_${suffix}`, {
  id: serial("id").primaryKey(),
  customer: text("customer").notNull(),
  cents: integer("cents").notNull(),
});
const Note = model(`dz_notes_${suffix}`, { invoiceId: t.int(), text: t.string().max(200) });
type NoteRow = { id: string; invoiceId: number; text: string };
type NotesTable = {
  insert(v: { invoiceId: number; text: string }): Promise<NoteRow>;
  findMany(o?: object): Promise<NoteRow[]>;
  count(): Promise<number>;
};
const notes = (db: unknown) => (db as Record<string, NotesTable>)[Note.name]!;

describe("db.$pgClient() without Postgres", () => {
  test("raises IL4028 with memory()", async () => {
    const app = createApp({ models: [Note], db: memory(), logger: quiet });
    await assert.rejects(() => app.db.$pgClient(), (e: InferloError) => e.code === "IL4028" && /memory adapter/.test(e.message) && /postgres\(/.test(e.fix ?? ""));
  });
});

describe("Drizzle next to Inferlo", { skip: !PG_URL && "set INFERLO_TEST_DATABASE_URL" }, () => {
  let pool: pg.Pool;
  let orm: ReturnType<typeof drizzle>;
  let app: ReturnType<typeof makeApp>;

  const makeApp = () => {
    const bill = route.post("/invoices", { body: t.object({ customer: t.string(), cents: t.int(), note: t.string() }) }).handle(async (ctx) => {
      // One transaction for both: the Drizzle insert and the Inferlo insert commit or roll back together.
      return ctx.db.$transaction(async (tx) => {
        const txOrm = drizzle({ client: await tx.$pgClient<pg.PoolClient>() });
        const [invoice] = await txOrm.insert(invoices).values({ customer: ctx.body.customer, cents: ctx.body.cents }).returning();
        const note = await notes(tx).insert({ invoiceId: invoice!.id, text: ctx.body.note });
        if (ctx.body.cents < 0) throw new InferloError("IL2004", "Negative amount.", { status: 422 });
        return { invoice, note };
      });
    });
    const list = route.get("/invoices").handle(async () => orm.select().from(invoices).orderBy(invoices.id));
    return createApp({ models: [Note], db: postgres({ pool }), routes: [{ bill, list }], auth: { resolve: () => null }, logger: quiet });
  };
  const user = { id: "dz-user" };

  before(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    orm = drizzle({ client: pool });
    // The Drizzle app's own table, as drizzle-kit would have created it.
    await orm.execute(sql.raw(`CREATE TABLE "dz_invoices_${suffix}" (id serial primary key, customer text not null, cents integer not null)`));
    app = makeApp();
    await app.db.$sync();
  });
  after(async () => {
    await pool.query(`DROP TABLE IF EXISTS "dz_invoices_${suffix}", "${Note.name}"`);
    await pool.end();
  });

  test("$pgClient() is the pool Inferlo and Drizzle share", async () => {
    assert.equal(await app.db.$pgClient(), pool);
    const client: PgClient = await app.db.$pgClient();
    assert.equal((await client.query("select 1 as one")).rows[0]!.one, 1);
  });

  test("a route writes with Drizzle and Inferlo in one transaction", async () => {
    const res = await app.request("/invoices", { method: "POST", json: { customer: "acme", cents: 1200, note: "first" }, as: user });
    assert.equal(res.status, 200);
    const { invoice, note } = (await res.json()) as { invoice: { id: number; customer: string }; note: NoteRow };
    assert.equal(note.invoiceId, invoice.id);
    const rows = await orm.select().from(invoices).where(eq(invoices.id, invoice.id));
    assert.deepEqual(rows.map((r) => r.customer), ["acme"]);
    assert.equal((await notes(app.db).findMany()).length, 1);
    const listed = await app.request("/invoices", { as: user });
    assert.deepEqual(((await listed.json()) as { customer: string }[]).map((r) => r.customer), ["acme"]);
  });

  test("a failure rolls back the Drizzle and the Inferlo writes together", async () => {
    const before = (await orm.select().from(invoices)).length;
    const notesBefore = await notes(app.db).count();
    const res = await app.request("/invoices", { method: "POST", json: { customer: "globex", cents: -5, note: "refund" }, as: user });
    assert.equal(res.status, 422);
    assert.equal((await orm.select().from(invoices)).length, before, "no Drizzle row");
    assert.equal(await notes(app.db).count(), notesBefore, "no Inferlo row");
  });

  test("inside a transaction $pgClient() is the transaction's connection, not the pool", async () => {
    await app.db.$transaction(async (tx) => {
      const client = await tx.$pgClient<pg.PoolClient>();
      assert.notEqual(client, pool);
      assert.equal(typeof client.release, "function");
      await drizzle({ client }).insert(invoices).values({ customer: "tx", cents: 1 });
      // Visible inside the transaction to Inferlo's raw SQL, which runs on the same connection.
      const seen = await tx.$sql(`select count(*)::int as n from "dz_invoices_${suffix}" where customer = 'tx'`);
      assert.equal(seen[0]!.n, 1);
      // Not yet visible to another connection.
      const outside = await pool.query(`select count(*)::int as n from "dz_invoices_${suffix}" where customer = 'tx'`);
      assert.equal(outside.rows[0].n, 0);
    });
    assert.equal((await orm.select().from(invoices).where(eq(invoices.customer, "tx"))).length, 1);
  });

  test("Inferlo's sync and migrations leave Drizzle's tables alone", async () => {
    assert.deepEqual(await app.db.$sync({ dryRun: true }), []);
    const plan = planMigration([Note]);
    assert.ok(plan.statements.every((s) => !s.includes("dz_invoices_")), "a first migration only creates Inferlo's tables");
    const dropped = planMigration([], plan.snapshot, { allowDrop: true });
    assert.ok(dropped.statements.some((s) => s.includes(Note.name)), "drops the removed Inferlo table");
    assert.ok(dropped.statements.every((s) => !s.includes("dz_invoices_")), "never Drizzle's tables");
  });
});
