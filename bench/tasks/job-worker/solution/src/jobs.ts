import { job, t } from "@browserlessapi/inferlo";

export const cleanupNotes = job("cleanup-notes", { input: t.object({}) }).handle(async ({ db }) => {
  await db.notes.deleteMany({ body: "" });
});
