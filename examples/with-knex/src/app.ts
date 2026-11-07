// An existing Knex app that adopts Inferlo next to it, on the same Postgres database:
// 1. Knex keeps its own pool; Inferlo gets a pg pool through postgres({ pool }).
// 2. Inferlo routes read and write Knex's tables with the Knex instance, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a Knex table: Knex queries run on the transaction's connection with .connection(client).
import knexFactory from "knex";
import pg from "pg";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";

// A new feature, built with Inferlo: notes on Knex's contacts.
export const ContactNote = model("contact_notes", {
  contactId: t.int().index(),
  body: t.string().min(1).max(2000),
});

export function makeApp(databaseUrl: string, logger?: { info(message: string): void; error(message: string): void }) {
  // Two pools on one database: keep their max sizes together under the server's max_connections.
  const knex = knexFactory({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 5 } });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const companyContacts = route
    .get("/companies/:id/contacts", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const company = await knex("crm_companies").select("id", "name").where({ id: params.id }).first();
      if (!company) throw notFound(`No company ${params.id}.`);
      const contacts: { id: number; email: string }[] = await knex("crm_contacts").select("id", "email").where({ company_id: params.id }).orderBy("id");
      const ids = contacts.map((c) => c.id);
      const notes = ids.length ? await db.contact_notes.findMany({ where: { contactId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
      return { company, contacts: contacts.map((c) => ({ ...c, notes: notes.filter((n) => n.contactId === c.id).map((n) => n.body) })) };
    });

  // A contact (Knex's table) and its first note (Inferlo) commit or roll back together.
  const createContact = route
    .post("/contacts", { body: t.object({ companyId: t.int(), email: t.email(), note: t.string().min(1).max(2000) }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const client = await tx.$pgClient<pg.PoolClient>();
        const [contact] = await knex("crm_contacts")
          .insert({ company_id: body.companyId, email: body.email })
          .returning(["id", "email"])
          .connection(client);
        const note = await tx.contact_notes.insert({ contactId: contact.id, body: body.note });
        status(201);
        return { contact, note };
      }),
    );

  const app = createApp({
    name: "with-knex",
    models: [ContactNote],
    db: postgres({ pool }),
    routes: [{ companyContacts, createContact }],
    auth: bearer((token) => users.get(token) ?? null),
    logger,
  });
  return { app, knex, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof ContactNote];
  }
}
