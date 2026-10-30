import { route } from "@kairojs/core";

export const listUsers = route
  .get("/admin/users", { auth: "admin", summary: "List all users" })
  .handle(({ db }) => db.users.findMany({ orderBy: { email: "asc" } }));
