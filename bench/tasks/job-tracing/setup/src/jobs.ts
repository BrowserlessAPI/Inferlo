import { job, t } from "@browserlessapi/inferlo";

// Sends the daily digest of a user's notes (the mail provider call is left out here).
export const sendDigest = job("send-digest", { input: t.object({ userId: t.uuid() }) }).handle(async ({ input, db }) => {
  await db.notes.findMany({ where: { ownerId: input.userId }, limit: 20 });
});
