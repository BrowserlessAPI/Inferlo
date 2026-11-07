import { route, t } from "@browserlessapi/inferlo";

export const reportLink = route
  .get("/reports/:name/link", { params: t.object({ name: t.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/) }) })
  .handle(async ({ params, user, storage }) => {
    const url = await storage.url(`reports/${user.id}/${params.name}`, { expiresIn: 300 });
    return new Response(null, { status: 303, headers: { location: url } });
  });
