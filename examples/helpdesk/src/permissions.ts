import { permissions } from "../../../src/index.ts";
import type { AppUser } from "./models.ts";

/** Named permissions, registered in models.ts so route `permission` options are checked by TypeScript. */
export const access = permissions({
  "tickets.close": { roles: ["agent"] },
  "tickets.triage": { roles: ["agent"] },
  "tickets.view": ({ user, ticket }: { user: AppUser; ticket: { ownerId: string } }) => ticket.ownerId === user.id || user.roles.includes("agent"),
});
