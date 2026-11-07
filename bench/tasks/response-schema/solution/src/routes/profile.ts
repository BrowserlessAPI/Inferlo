import { notFound, route, t } from "@browserlessapi/inferlo";

const Profile = t.object({ id: t.uuid(), email: t.email(), name: t.string() });

export const getProfile = route.get("/me/profile", { response: Profile, summary: "The signed-in user's profile" }).handle(async ({ db, user }) => {
  const row = await db.users.find(user.id);
  if (!row) throw notFound("No profile for this user.");
  return { id: row.id, email: row.email, name: row.name };
});
