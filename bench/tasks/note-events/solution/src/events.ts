import { event, t } from "@browserlessapi/inferlo";

export const noteDeleted = event("note.deleted", { payload: t.object({ noteId: t.uuid(), ownerId: t.uuid() }) });
