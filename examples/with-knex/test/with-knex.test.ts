import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeApp } from "../src/app.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
const quiet = { info() {}, error() {} };
let ctx: ReturnType<typeof makeApp>;
let companyId = 0;

async function dropAll() {
  await ctx.knex.schema.dropTableIfExists("crm_contacts").dropTableIfExists("crm_companies").dropTableIfExists("contact_notes");
}

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL, quiet);
  await dropAll();
  // The tables the existing app's Knex migrations created.
  await ctx.knex.schema.createTable("crm_companies", (table) => {
    table.increments("id");
    table.string("name", 200).notNullable();
  });
  await ctx.knex.schema.createTable("crm_contacts", (table) => {
    table.increments("id");
    table.integer("company_id").notNullable().references("id").inTable("crm_companies");
    table.string("email", 320).notNullable().unique();
  });
  await ctx.app.db.$sync();
  [{ id: companyId }] = await ctx.knex("crm_companies").insert({ name: "Acme" }).returning("id");
});
after(async () => {
  if (!PG_URL) return;
  await dropAll();
  await ctx.app.close();
  await ctx.knex.destroy();
  await ctx.pool.end();
});

test("a contact (Knex's table) and its note (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: "ada@acme.test", note: "Met at the fair" } });
  assert.equal(res.status, 201);
  const { contact, note } = (await res.json()) as { contact: { id: number; email: string }; note: { contactId: number } };
  assert.equal(note.contactId, contact.id);
  assert.equal(contact.email, "ada@acme.test");
  assert.deepEqual(await ctx.knex("crm_contacts").where({ id: contact.id }).first(), { id: contact.id, company_id: companyId, email: "ada@acme.test" });

  const list = await ctx.app.request(`/companies/${companyId}/contacts`, { headers: auth });
  assert.deepEqual(await list.json(), { company: { id: companyId, name: "Acme" }, contacts: [{ id: contact.id, email: "ada@acme.test", notes: ["Met at the fair"] }] });
});

test("when a write fails, both roll back and the pools keep working", { skip }, async () => {
  const before = await ctx.app.db.contact_notes.count();
  const contactsBefore = (await ctx.knex("crm_contacts").count({ n: "*" }))[0]!.n;
  // Knex's own errors (a foreign key or unique violation) are not Inferlo errors: 500, details logged, not sent.
  const missing = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId: 999_999, email: "bob@acme.test", note: "x" } });
  assert.equal(missing.status, 500);
  const duplicate = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: "ada@acme.test", note: "x" } });
  assert.equal(duplicate.status, 500);
  assert.equal(await ctx.app.db.contact_notes.count(), before);
  assert.equal((await ctx.knex("crm_contacts").count({ n: "*" }))[0]!.n, contactsBefore);

  // An error after Knex's insert, inside the Inferlo transaction, rolls back Knex's row too.
  const failing = await ctx.app.db.$transaction(async (tx) => {
    await ctx.knex("crm_contacts").insert({ company_id: companyId, email: "cy@acme.test" }).connection(await tx.$pgClient());
    throw new Error("stop");
  }).catch((e: Error) => e.message);
  assert.equal(failing, "stop");
  assert.equal(await ctx.knex("crm_contacts").where({ email: "cy@acme.test" }).first(), undefined);

  for (let i = 0; i < 12; i++) {
    const ok = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: `user${i}@acme.test`, note: "ok" } });
    assert.equal(ok.status, 201, "connections went back to the pool");
  }
});

test("a missing company is 404, routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request("/companies/999999/contacts", { headers: auth })).status, 404);
  assert.equal((await ctx.app.request(`/companies/${companyId}/contacts`)).status, 401);
  assert.equal((await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: "not an email", note: "x" } })).status, 422);
});

test("Knex's migrations leave Inferlo's tables alone", { skip }, async () => {
  // Knex's migrator keeps its history in knex_migrations and runs only its own files.
  await ctx.knex.migrate.latest({ migrationSource: { getMigrations: async () => ["001_add_phone"], getMigrationName: (m: string) => m, getMigration: async () => ({ up: (k: typeof ctx.knex) => k.schema.alterTable("crm_contacts", (t) => t.string("phone", 40)), down: (k: typeof ctx.knex) => k.schema.alterTable("crm_contacts", (t) => t.dropColumn("phone")) }) } });
  const columns = await ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'contact_notes' order by column_name");
  assert.deepEqual(columns.map((c) => c.column_name), ["body", "contact_id", "created_at", "id", "updated_at"]);
  await ctx.knex.migrate.rollback({ migrationSource: { getMigrations: async () => ["001_add_phone"], getMigrationName: (m: string) => m, getMigration: async () => ({ up: async () => {}, down: (k: typeof ctx.knex) => k.schema.alterTable("crm_contacts", (t) => t.dropColumn("phone")) }) } }, true);
  await ctx.knex.schema.dropTableIfExists("knex_migrations").dropTableIfExists("knex_migrations_lock");
});

test("Inferlo's sync leaves Knex's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"crm_companies"') && !s.includes('"crm_contacts"')), statements.join("\n"));
});
