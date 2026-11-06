import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { makeApp } from "../src/app.ts";
import * as schema from "../src/schema.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
let ctx: ReturnType<typeof makeApp>;
let customerId = 0;

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL);
  // The tables drizzle-kit would have created for the existing app.
  await ctx.orm.execute(sql`DROP TABLE IF EXISTS invoices, customers, reminders`);
  await ctx.orm.execute(sql`CREATE TABLE customers (id serial primary key, name text not null)`);
  await ctx.orm.execute(sql`CREATE TABLE invoices (id serial primary key, customer_id integer not null references customers(id), cents integer not null, created_at timestamp not null default now())`);
  await ctx.app.db.$sync();
  const [customer] = await ctx.orm.insert(schema.customers).values({ name: "Acme" }).returning();
  customerId = customer!.id;
});
after(async () => {
  if (!PG_URL) return;
  await ctx.orm.execute(sql`DROP TABLE IF EXISTS invoices, customers, reminders`);
  await ctx.pool.end();
});

test("an invoice (Drizzle) and its reminder (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId, cents: 1500, reminder: "Due in 30 days" } });
  assert.equal(res.status, 201);
  const { invoice, reminder } = (await res.json()) as { invoice: { id: number }; reminder: { invoiceId: number } };
  assert.equal(reminder.invoiceId, invoice.id);
  const total = await ctx.app.request(`/customers/${customerId}/total`, { headers: auth });
  assert.deepEqual(await total.json(), { customerId, cents: 1500 });
});

test("when the Drizzle insert fails, nothing is written", { skip }, async () => {
  const before = await ctx.app.db.reminders.count();
  const res = await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId: 999_999, cents: 100, reminder: "Nobody" } });
  // Drizzle's own errors are not Inferlo errors: the route answers 500 (details are logged, not sent).
  assert.equal(res.status, 500);
  assert.equal(await ctx.app.db.reminders.count(), before);
});

test("routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request(`/customers/${customerId}/total`)).status, 401);
  assert.equal((await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId, cents: 0, reminder: "x" } })).status, 422);
});
