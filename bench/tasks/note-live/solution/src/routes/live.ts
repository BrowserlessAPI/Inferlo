import { notFound, route, t } from "@browserlessapi/inferlo";

export const liveNote = route
  .ws("/notes/:id/live", {
    params: t.object({ id: t.uuid() }),
    message: t.object({ body: t.string().max(10_000) }),
    rateLimit: { max: 120, per: "minute", by: "user" },
    summary: "Edit a note live",
  })
  .handle(async ({ params, message, user, db }) => {
    const note = await db.notes.findOne({ id: params.id });
    if (!note || note.ownerId !== user.id) throw notFound("Note not found");
    return db.notes.update(note.id, { body: message.body });
  });
