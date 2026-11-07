import { route, t } from "@browserlessapi/inferlo";

export const uploadAvatar = route
  .post("/me/avatar", {
    body: t.object({
      image: t.file({ maxBytes: 1_000_000, types: ["image/png", "image/jpeg"] }),
      alt: t.string().max(120).optional(),
    }),
    summary: "Upload the signed-in user's avatar",
  })
  .handle(({ body }) => ({ name: body.image.name, size: body.image.size, type: body.image.type, alt: body.alt ?? null }));
