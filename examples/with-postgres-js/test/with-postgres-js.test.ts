import assert from "node:assert/strict";
import type { ReservedSql } from "postgres";
import { after, before, test } from "node:test";
import { InferloError } from "../../../src/index.ts";
import { postgresJsPool, type PostgresJsClient } from "../../../src/postgres-js.ts";
import { makeApp } from "../src/app.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
const quiet = { info() {}, error() {} };
let ctx: ReturnType<typeof makeApp>;
let companyId = 0;

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL, quiet);
  const { sql } = ctx;
  await sql`drop table if exists crm_contacts, crm_companies, contact_notes`;
  // The tables the existing app's migrations created.
  await sql`create table crm_companies (id serial primary key, name varchar(200) not null)`;
  await sql`create table crm_contacts (id serial primary key, company_id integer not null references crm_companies(id), email varchar(320) not null unique)`;
  await ctx.app.db.$sync();
  companyId = (await sql<{ id: number }[]>`insert into crm_companies (name) values ('Acme') returning id`)[0]!.id;
});
after(async () => {
  if (!PG_URL) return;
  await ctx.sql`drop table if exists crm_contacts, crm_companies, contact_notes`;
  await ctx.app.close();
  await ctx.sql.end();
});

test("a contact (postgres.js) and its note (Inferlo) are written in one transaction on one pool", { skip }, async () => {
  const res = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: "ada@acme.test", note: "Met at the fair", tags: ["fair", "lead"] } });
  assert.equal(res.status, 201, await res.clone().text());
  const { contact, note } = (await res.json()) as { contact: { id: number; email: string }; note: { contactId: number; tags: string[] } };
  assert.equal(note.contactId, contact.id);
  assert.deepEqual(note.tags, ["fair", "lead"], "JSON fields are stored as JSON, not as a string");
  const [row] = await ctx.sql`select company_id, email from crm_contacts where id = ${contact.id}`;
  assert.deepEqual({ ...row }, { company_id: companyId, email: "ada@acme.test" });
  const [stored] = await ctx.sql`select jsonb_typeof(tags) as type from contact_notes where contact_id = ${contact.id}`;
  assert.equal(stored!.type, "array");

  const list = await ctx.app.request(`/companies/${companyId}/contacts`, { headers: auth });
  assert.deepEqual(await list.json(), { company: { id: companyId, name: "Acme" }, contacts: [{ id: contact.id, email: "ada@acme.test", notes: ["Met at the fair"] }] });
  assert.deepEqual((await ctx.app.db.contact_notes.findMany({ where: { tags: { eq: ["fair", "lead"] } } })).length, 1, "JSON values in where");
});

test("when a write fails, both roll back and the pool keeps working", { skip }, async () => {
  const before = await ctx.app.db.contact_notes.count();
  const contactsBefore = (await ctx.sql<{ n: string }[]>`select count(*) as n from crm_contacts`)[0]!.n;
  // postgres.js's own errors are not Inferlo errors: 500, details logged, not sent.
  const missing = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId: 999_999, email: "bob@acme.test", note: "x" } });
  assert.equal(missing.status, 500);
  const duplicate = await ctx.app.request("/contacts", { method: "POST", headers: auth, json: { companyId, email: "ada@acme.test", note: "x" } });
  assert.equal(duplicate.status, 500);
  assert.equal(await ctx.app.db.contact_notes.count(), before);
  assert.equal((await ctx.sql<{ n: string }[]>`select count(*) as n from crm_contacts`)[0]!.n, contactsBefore);

  // An error after postgres.js's insert, inside the Inferlo transaction, rolls it back too.
  const failing = await ctx.app.db
    .$transaction(async (tx) => {
      const { sql } = await tx.$pgClient<PostgresJsClient<ReservedSql>>();
      await sql`insert into crm_contacts (company_id, email) values (${companyId}, 'cy@acme.test')`;
      throw new Error("stop");
    })
    .catch((e: Error) => e.message);
  assert.equal(failing, "stop");
  assert.equal((await ctx.sql`select id from crm_contacts where email = 'cy@acme.test'`).length, 0);

  // Inferlo's errors read postgres.js's errors as for pg: a unique violation in a model is 409 IL4004.
  await ctx.app.db.$sql('create unique index if not exists contact_notes_body_unique on contact_notes (body)');
  const conflict = await ctx.app.db.contact_notes.insert({ contactId: 1, body: "Met at the fair" }).catch((e: unknown) => e);
  assert.ok(conflict instanceof InferloError && conflict.code === "IL4004" && conflict.status === 409, String(conflict));
  assert.equal((conflict.details as { table?: string }).table, "contact_notes");
  await ctx.app.db.$sql("drop index contact_notes_body_unique");

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

test("Inferlo's sync leaves the app's own tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"crm_companies"') && !s.includes('"crm_contacts"')), statements.join("\n"));
});

test("postgresJsPool(sql) needs a postgres.js sql instance (IL4029)", () => {
  for (const value of [undefined, {}, "postgres://localhost/app", { unsafe() {} }]) {
    assert.throws(() => postgresJsPool(value as never), (e: unknown) => e instanceof InferloError && e.code === "IL4029" && Boolean(e.fix));
  }
});
