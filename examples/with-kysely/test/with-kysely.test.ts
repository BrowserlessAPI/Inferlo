import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "kysely";
import { makeApp } from "../src/app.ts";
import { migrations } from "../src/database.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
let ctx: ReturnType<typeof makeApp>;
// Kysely 0.29 moved the Migrator to "kysely/migration"; 0.28 exports it from "kysely".
type Migrator = { migrateToLatest(): Promise<{ error?: unknown; results?: unknown[] }> };
let migrator: Migrator;

async function migratorFor(db: unknown): Promise<Migrator> {
  const root: Record<string, any> = await import("kysely");
  const Migrator = root.Migrator ?? ((await import("kysely/" + "migration")) as Record<string, any>).Migrator;
  return new Migrator({ db, provider: { getMigrations: async () => migrations } });
}
let warehouseId = 0;

async function dropAll() {
  await sql`DROP TABLE IF EXISTS shipments, warehouses, tracking_events, kysely_migration, kysely_migration_lock`.execute(ctx.kysely);
}

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL);
  await dropAll();
  // The existing app's tables, created by Kysely's Migrator; then Inferlo's.
  migrator = await migratorFor(ctx.kysely);
  const { error } = await migrator.migrateToLatest();
  assert.ifError(error);
  await ctx.app.db.$sync();
  const warehouse = await ctx.kysely.insertInto("warehouses").values({ name: "Rotterdam" }).returning("id").executeTakeFirstOrThrow();
  warehouseId = warehouse.id;
});
after(async () => {
  if (!PG_URL) return;
  await dropAll();
  await ctx.app.close();
  await ctx.kysely.destroy();
});

test("a shipment (Kysely) and its tracking event (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/shipments", { method: "POST", headers: auth, json: { warehouseId, reference: "RTM-1", note: "Two pallets" } });
  assert.equal(res.status, 201);
  const { shipment, event } = (await res.json()) as { shipment: { id: number; reference: string }; event: { shipmentId: number; status: string } };
  assert.equal(event.shipmentId, shipment.id);
  assert.equal(event.status, "created");
  // Kysely's own pool sees the committed row.
  const saved = await ctx.kysely.selectFrom("shipments").selectAll().where("id", "=", shipment.id).executeTakeFirst();
  assert.equal(saved?.reference, "RTM-1");
  assert.ok(saved?.created_at instanceof Date);
  const list = await ctx.app.request(`/warehouses/${warehouseId}/shipments`, { headers: auth });
  assert.deepEqual(await list.json(), { warehouse: { id: warehouseId, name: "Rotterdam" }, shipments: [{ id: shipment.id, reference: "RTM-1", statuses: ["created"] }] });
});

test("when the Kysely insert fails, nothing is written, and the pool keeps working", { skip }, async () => {
  const before = await ctx.app.db.tracking_events.count();
  // The reference is unique in Kysely's table, so the second insert fails inside the transaction.
  const res = await ctx.app.request("/shipments", { method: "POST", headers: auth, json: { warehouseId, reference: "RTM-1" } });
  // Kysely's own errors are not Inferlo errors: the route answers 500 (details are logged, not sent).
  assert.equal(res.status, 500);
  assert.equal(await ctx.app.db.tracking_events.count(), before);
  const missing = await ctx.app.request("/shipments", { method: "POST", headers: auth, json: { warehouseId: 999_999, reference: "NOPE" } });
  assert.equal(missing.status, 500);
  assert.equal(await ctx.app.db.tracking_events.count(), before);
  // The transaction's connection went back to the pool: both clients still answer.
  for (let i = 0; i < 12; i++) {
    const ok = await ctx.app.request("/shipments", { method: "POST", headers: auth, json: { warehouseId, reference: `RTM-B${i}` } });
    assert.equal(ok.status, 201);
  }
  assert.equal(ctx.pool.totalCount <= 10, true);
});

test("a missing warehouse is 404, routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request("/warehouses/999999/shipments", { headers: auth })).status, 404);
  assert.equal((await ctx.app.request(`/warehouses/${warehouseId}/shipments`)).status, 401);
  assert.equal((await ctx.app.request("/shipments", { method: "POST", headers: auth, json: { warehouseId, reference: "" } })).status, 422);
});

test("Kysely's Migrator and Inferlo's sync leave each other's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.deepEqual(statements.filter((s) => /"(shipments|warehouses|kysely_migration\w*)"/.test(s)), [], statements.join("\n"));
  const again = await migrator.migrateToLatest();
  assert.ifError(again.error);
  assert.deepEqual(again.results, []);
  const columns = await ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'tracking_events' order by column_name");
  assert.deepEqual(columns.map((c) => c.column_name), ["created_at", "id", "note", "shipment_id", "status", "updated_at"]);
});
