import { job, t } from "@browserlessapi/inferlo";

export const uppercaseTitle = job("uppercase-title", { input: t.object({ noteId: t.uuid() }) }).handle(async ({ input, db }) => {
  const note = await db.notes.find(input.noteId);
  if (!note) return;
  await db.notes.update(note.id, { title: note.title.toUpperCase() });
});
