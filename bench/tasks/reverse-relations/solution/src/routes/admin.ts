import { route } from "@browserlessapi/inferlo";

export const listUsers = route
  .get("/admin/users", { auth: "admin", summary: "List all users with their notes" })
  .handle(({ db }) => db.users.findMany({ orderBy: { email: "asc" }, include: { notes: true } }));
