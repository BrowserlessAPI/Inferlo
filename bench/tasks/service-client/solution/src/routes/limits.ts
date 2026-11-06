import { route, ServiceCallError } from "@browserlessapi/inferlo";
import { getPlan } from "../billing/routes.ts";
import { billing } from "../clients.ts";

const MAX_NOTES = { free: 10, pro: 1000 } as const;

export const limits = route.get("/limits").handle(async (ctx) => {
  let plan: "free" | "pro" = "free";
  try {
    plan = (await billing.call(getPlan, { params: { userId: ctx.user.id }, ctx })).plan;
  } catch (error) {
    if (!(error instanceof ServiceCallError && error.remoteStatus === 404)) throw error;
  }
  return { plan, maxNotes: MAX_NOTES[plan] };
});
