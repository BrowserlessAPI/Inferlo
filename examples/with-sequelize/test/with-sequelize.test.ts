import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeApp } from "../src/app.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
let ctx: ReturnType<typeof makeApp>;
let customerId = 0;

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL);
  await ctx.sequelize.query("DROP TABLE IF EXISTS shop_orders, shop_customers, shipping_labels");
  // The tables Sequelize's migrations (or sync) created for the existing app.
  await ctx.sequelize.sync();
  await ctx.app.db.$sync();
  const customer = await ctx.Customer.create({ name: "Acme" });
  customerId = customer.id;
});
after(async () => {
  if (!PG_URL) return;
  await ctx.sequelize.query("DROP TABLE IF EXISTS shop_orders, shop_customers, shipping_labels");
  await ctx.app.close();
  await ctx.sequelize.close();
  await ctx.pool.end();
});

test("an order (Sequelize's table) and its label (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/orders", { method: "POST", headers: auth, json: { customerId, reference: "A-1", cents: 4900, carrier: "dhl" } });
  assert.equal(res.status, 201);
  const { order, label } = (await res.json()) as { order: { id: number }; label: { orderId: number } };
  assert.equal(label.orderId, order.id);

  // Sequelize sees the committed row, with its association and timestamps.
  const saved = await ctx.Order.findByPk(order.id, { include: [{ model: ctx.Customer, as: "customer" }] });
  assert.equal((saved?.get("customer") as { name: string } | undefined)?.name, "Acme");
  assert.ok(saved?.get("createdAt") instanceof Date);

  const list = await ctx.app.request(`/customers/${customerId}/orders`, { headers: auth });
  assert.deepEqual(await list.json(), { customer: { id: customerId, name: "Acme" }, orders: [{ id: order.id, reference: "A-1", cents: 4900, labels: ["dhl"] }] });
});

test("when the write to Sequelize's table fails, nothing is written", { skip }, async () => {
  const before = await ctx.app.db.shipping_labels.count();
  // A missing customer (foreign key) and a reference that is already used (unique) are Inferlo's 409 conflicts.
  const missing = await ctx.app.request("/orders", { method: "POST", headers: auth, json: { customerId: 999_999, reference: "B-1", cents: 100, carrier: "ups" } });
  assert.equal(missing.status, 409);
  const duplicate = await ctx.app.request("/orders", { method: "POST", headers: auth, json: { customerId, reference: "A-1", cents: 100, carrier: "ups" } });
  assert.equal(duplicate.status, 409);
  assert.equal(await ctx.app.db.shipping_labels.count(), before);
  assert.equal(await ctx.Order.count({ where: { reference: "B-1" } }), 0);
  // The pool still works after failed transactions.
  assert.equal((await ctx.app.request("/orders", { method: "POST", headers: auth, json: { customerId, reference: "A-2", cents: 100, carrier: "ups" } })).status, 201);
});

test("a missing customer is 404, routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request("/customers/999999/orders", { headers: auth })).status, 404);
  assert.equal((await ctx.app.request(`/customers/${customerId}/orders`)).status, 401);
  assert.equal((await ctx.app.request("/orders", { method: "POST", headers: auth, json: { customerId, reference: "C-1", cents: 1, carrier: "post" } })).status, 422);
});

test("Sequelize's sync leaves Inferlo's tables alone", { skip }, async () => {
  const columns = async () => ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'shipping_labels' order by column_name");
  const before = await columns();
  await ctx.sequelize.sync({ alter: true });
  assert.deepEqual(await columns(), before);
  assert.deepEqual(before.map((c) => c.column_name), ["carrier", "created_at", "id", "order_id", "updated_at"]);
  assert.equal(await ctx.app.db.shipping_labels.count(), 2, "Inferlo's rows are still there");
});

test("Inferlo's sync leaves Sequelize's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"shop_customers"') && !s.includes('"shop_orders"')), statements.join("\n"));
});
