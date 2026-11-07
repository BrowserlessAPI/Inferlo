import { route, t } from "@browserlessapi/inferlo";
import { knex } from "../knex.ts";

export const createContact = route
  .post("/contacts", {
    body: t.object({ companyId: t.int(), email: t.email(), note: t.string().min(1).max(2000) }),
    summary: "Create a contact with its first note",
  })
  .handle(async ({ body, db, status }) => {
    // Knex runs on the Inferlo transaction's connection, so both writes commit or roll back together.
    const result = await db.$transaction(async (tx) => {
      const [contact] = await knex("crm_contacts").insert({ company_id: body.companyId, email: body.email }).returning("id").connection(await tx.$pgClient());
      const note = await tx.contact_notes.insert({ contactId: Number(contact.id), body: body.note });
      return { contactId: Number(contact.id), note };
    });
    status(201);
    return result;
  });
