import { route, t } from "@browserlessapi/inferlo";
import { settings } from "../config.ts";

// Stripe signs each event with the endpoint's signing secret; unsigned or forged requests answer 401 IL3012.
export const stripeEvents = route
  .post("/webhooks/stripe", {
    auth: "public",
    webhook: { scheme: "stripe", secret: settings.STRIPE_WEBHOOK_SECRET },
    body: t.object({ id: t.string(), type: t.string() }).strip(),
  })
  .handle(() => ({ received: true }));
