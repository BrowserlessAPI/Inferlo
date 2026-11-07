import { notFound, route, t } from "@browserlessapi/inferlo";

export const putAvatar = route
  .put("/me/avatar", { body: t.object({ image: t.file({ maxBytes: 500_000, types: ["image/png"] }) }), summary: "Store the signed-in user's avatar" })
  .handle(({ body, user, storage }) => storage.put(`avatars/${user.id}`, body.image));

export const getAvatar = route.get("/me/avatar", { summary: "The signed-in user's avatar" }).handle(async ({ user, storage }) => {
  const file = await storage.get(`avatars/${user.id}`);
  if (!file) throw notFound("No avatar yet.");
  return new Response(file, { headers: { "content-type": file.type } });
});
