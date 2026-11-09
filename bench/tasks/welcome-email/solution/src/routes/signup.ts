import { route } from "@browserlessapi/inferlo";
import { sendWelcome } from "../jobs.ts";
import { User } from "../models.ts";

export const signup = route
  .post("/signup", { auth: "public", body: User.pick("email", "name"), summary: "Create an account", rateLimit: { max: 10, per: "minute" } })
  .handle(async ({ body, db, jobs, status }) => {
    const user = await db.users.insert({ email: body.email, name: body.name });
    await jobs.enqueue(sendWelcome, { userId: user.id });
    status(201);
    return { id: user.id, email: user.email, name: user.name };
  });
