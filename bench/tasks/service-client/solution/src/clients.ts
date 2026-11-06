import { serviceClient } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";

export const billing = serviceClient({ baseUrl: "http://billing.internal", token: settings.BILLING_TOKEN });
