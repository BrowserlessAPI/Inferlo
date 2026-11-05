import { job, t } from "@browserlessapi/inferlo";

export const countNotes = job("count-notes", { input: t.object({}) }).handle(async ({ db }) => {
  console.log(`notes: ${await db.notes.count()}`);
});
