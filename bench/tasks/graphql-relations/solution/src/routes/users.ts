import { route, t } from "@browserlessapi/inferlo";
import { User } from "../models.ts";

// One call answers every user a GraphQL list needs (the owners of all notes in it).
export const usersByIds = route
  .get("/users", { summary: "Users by id", query: t.object({ ids: t.array(t.uuid()).max(100) }), response: t.array(User.row) })
  .handle(({ query, db }) => db.users.findMany({ where: { id: { in: query.ids } } }));
