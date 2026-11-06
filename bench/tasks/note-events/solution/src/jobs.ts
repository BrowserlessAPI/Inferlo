import { job, on } from "@browserlessapi/inferlo";
import { noteDeleted } from "./events.ts";

export const notifyOwner = job("notify-owner", { input: noteDeleted.payload }).handle(({ input }) => {
  console.log(`note ${input.noteId} was deleted`);
});

export const onNoteDeleted = on(noteDeleted, notifyOwner);
