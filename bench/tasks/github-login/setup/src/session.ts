import { sessions } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";

export const session = sessions({
  secret: settings.SESSION_SECRET,
  async user({ userId }, { db }) {
    const user = await db.users.find(userId);
    return user ? { id: user.id, email: user.email, name: user.name, roles: [user.role] } : null;
  },
});
