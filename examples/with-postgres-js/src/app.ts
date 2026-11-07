// An existing postgres.js app that adopts Inferlo next to it, on the same Postgres database and the same pool:
// 1. Inferlo's Postgres adapter runs on the app's postgres.js sql instance: postgres({ pool: postgresJsPool(sql) }).
// 2. Inferlo routes read and write the existing tables with postgres.js, imported like any module.
// 3. A new table as an Inferlo model, written in one transaction with an existing table: inside db.$transaction,
//    tx.$pgClient<PostgresJsClient>() gives the transaction's connection as postgres.js `sql`.
import postgresJs, { type ReservedSql } from "postgres";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import { postgresJsPool, type PostgresJsClient } from "../../../src/postgres-js.ts";

// A new feature, built with Inferlo: notes on the existing contacts.
export const ContactNote = model("contact_notes", {
  contactId: t.int().index(),
  body: t.string().min(1).max(2000),
  tags: t.array(t.string()).max(10).default([]),
});

export function makeApp(databaseUrl: string, logger?: { info(message: string): void; error(message: string): void }) {
  // One pool for both: postgres.js opens connections as queries need them, up to max.
  const sql = postgresJs(databaseUrl, { max: 5, onnotice: () => {} });
  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const companyContacts = route
    .get("/companies/:id/contacts", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const [company] = await sql<{ id: number; name: string }[]>`select id, name from crm_companies where id = ${params.id}`;
      if (!company) throw notFound(`No company ${params.id}.`);
      const contacts = await sql<{ id: number; email: string }[]>`select id, email from crm_contacts where company_id = ${params.id} order by id`;
      const ids = contacts.map((c) => c.id);
      const notes = ids.length ? await db.contact_notes.findMany({ where: { contactId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
      return { company: { id: company.id, name: company.name }, contacts: contacts.map((c) => ({ id: c.id, email: c.email, notes: notes.filter((n) => n.contactId === c.id).map((n) => n.body) })) };
    });

  // A contact (postgres.js) and its first note (Inferlo) commit or roll back together.
  const createContact = route
    .post("/contacts", { body: t.object({ companyId: t.int(), email: t.email(), note: t.string().min(1).max(2000), tags: t.array(t.string()).max(10).optional() }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const { sql: txSql } = await tx.$pgClient<PostgresJsClient<ReservedSql>>();
        const [contact] = await txSql<{ id: number; email: string }[]>`insert into crm_contacts ${txSql({ company_id: body.companyId, email: body.email })} returning id, email`;
        const note = await tx.contact_notes.insert({ contactId: contact!.id, body: body.note, tags: body.tags ?? [] });
        status(201);
        return { contact: { id: contact!.id, email: contact!.email }, note };
      }),
    );

  const app = createApp({
    name: "with-postgres-js",
    models: [ContactNote],
    db: postgres({ pool: postgresJsPool(sql) }),
    routes: [{ companyContacts, createContact }],
    auth: bearer((token) => users.get(token) ?? null),
    logger,
  });
  return { app, sql };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof ContactNote];
  }
}
