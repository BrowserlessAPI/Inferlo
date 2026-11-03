import { cron, job, t } from "@browserlessapi/inferlo";

export const deleteEmptyNotes = job("delete-empty-notes", { input: t.object({}) }).handle(async ({ db }) => {
  await db.notes.deleteMany({ body: "" });
});

export const nightlyCleanup = cron("0 3 * * *", deleteEmptyNotes);
