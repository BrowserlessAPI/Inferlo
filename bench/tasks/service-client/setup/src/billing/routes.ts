// Routes of the billing service, a separate Inferlo app deployed at http://billing.internal.
// They are shared with this app for typed calls; their handlers run in the billing service only.
import { notFound, route, t } from "@browserlessapi/inferlo";

export const getPlan = route
  .get("/accounts/:userId/plan", { params: t.object({ userId: t.uuid() }) })
  .handle((): { plan: "free" | "pro"; renewsAt: string | null } => {
    throw notFound();
  });
