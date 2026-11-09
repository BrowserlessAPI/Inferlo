import { job, t } from "@browserlessapi/inferlo";

export const sendWelcome = job("send-welcome", { input: t.object({ userId: t.uuid() }), retries: 5, summary: "Email a new user the welcome message" }).handle(async ({ input, db, mail }) => {
  const user = await db.users.get(input.userId);
  await mail.send({ to: user.email, template: "welcome", data: { name: user.name } });
});
