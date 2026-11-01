import { route } from "@browserlessapi/inferlo";

export const listUsers = route
  .get("/admin/users", { auth: "admin", summary: "List all users" })
  .handle(({ db }) => db.users.findMany({ orderBy: { email: "asc" } }));
