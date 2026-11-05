import { permissions, type Row } from "@browserlessapi/inferlo";
import type { AppUser, Note } from "./models.ts";

export const access = permissions({
  "notes.delete": ({ user, note }: { user: AppUser; note: Row<typeof Note> }) => note.ownerId === user.id || user.roles.includes("admin"),
  "notes.stats": { roles: ["admin"] },
});
