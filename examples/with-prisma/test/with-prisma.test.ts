import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensurePrismaClient } from "../generate.ts";

// The Prisma client is generated code: generate it (as a Prisma app's build does) before importing the app.
ensurePrismaClient();
const { makeApp } = await import("../src/app.ts");

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
let ctx: ReturnType<typeof makeApp>;
let customerId = 0;

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL);
  // The tables Prisma Migrate would have created for the existing app.
  await ctx.pool.query(`DROP TABLE IF EXISTS crm_invoices, crm_customers, crm_reminders`);
  await ctx.pool.query(`CREATE TABLE crm_customers (id serial primary key, name text not null)`);
  await ctx.pool.query(`CREATE TABLE crm_invoices (id serial primary key, customer_id integer not null references crm_customers(id), cents integer not null, created_at timestamp(3) not null default current_timestamp)`);
  await ctx.app.db.$sync();
  customerId = (await ctx.prisma.customer.create({ data: { name: "Acme" } })).id;
});
after(async () => {
  if (!PG_URL) return;
  await ctx.pool.query(`DROP TABLE IF EXISTS crm_invoices, crm_customers, crm_reminders`);
  await ctx.close();
});

test("Prisma and Inferlo share one pg pool", { skip }, async () => {
  assert.equal(await ctx.app.db.$pgClient(), ctx.pool);
  // A Prisma write is visible to Inferlo's queries at once, on the same database.
  const [row] = await ctx.app.db.$sql("select name from crm_customers where id = $1", [customerId]);
  assert.equal(row!.name, "Acme");
});

test("an invoice (Prisma's table) and its reminder (Inferlo) are written in one transaction, and a job uses Prisma", { skip }, async () => {
  const res = await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId, cents: 1500, reminder: "Due in 30 days" } });
  assert.equal(res.status, 201);
  const { invoice, reminder } = (await res.json()) as { invoice: { id: number; customerId: number }; reminder: { id: string; invoiceId: number } };
  assert.equal(invoice.customerId, customerId);
  assert.equal(reminder.invoiceId, invoice.id);

  // Prisma reads what Inferlo's transaction wrote.
  assert.equal((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).cents, 1500);
  const total = await ctx.app.request(`/customers/${customerId}/total`, { headers: auth });
  assert.deepEqual(await total.json(), { customerId, name: "Acme", cents: 1500 });

  // The job queued in the transaction reads the invoice and customer with Prisma.
  await ctx.app.jobs.runDue();
  const sent = await ctx.app.db.crm_reminders.get(reminder.id);
  assert.ok(sent.sentAt instanceof Date);
  assert.equal(sent.message, "Due in 30 days (Acme)");

  const detail = await ctx.app.request(`/invoices/${invoice.id}`, { headers: auth });
  const body = (await detail.json()) as { customer: string; reminders: { id: string }[] };
  assert.equal(body.customer, "Acme");
  assert.deepEqual(body.reminders.map((r) => r.id), [reminder.id]);
});

test("when the invoice insert fails, the reminder is rolled back too", { skip }, async () => {
  const reminders = await ctx.app.db.crm_reminders.count();
  const invoices = await ctx.prisma.invoice.count();
  const res = await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId: 999_999, cents: 100, reminder: "Nobody" } });
  // Inferlo turns the foreign key violation from its own SQL into a 409 answer.
  assert.equal(res.status, 409);
  assert.equal(await ctx.app.db.crm_reminders.count(), reminders);
  assert.equal(await ctx.prisma.invoice.count(), invoices);
});

test("Prisma lookups that find nothing answer 404, and routes stay private and validate input", { skip }, async () => {
  const missing = await ctx.app.request("/customers/999999/total", { headers: auth });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "IL4001");
  assert.equal((await ctx.app.request(`/customers/${customerId}/total`)).status, 401);
  assert.equal((await ctx.app.request("/invoices", { method: "POST", headers: auth, json: { customerId, cents: 0, reminder: "x" } })).status, 422);
});

test("Inferlo's sync leaves Prisma's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"crm_invoices"') && !s.includes('"crm_customers"')), statements.join("\n"));
  const columns = await ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'crm_invoices' order by column_name");
  assert.deepEqual(columns.map((c) => c.column_name), ["cents", "created_at", "customer_id", "id"]);
});
