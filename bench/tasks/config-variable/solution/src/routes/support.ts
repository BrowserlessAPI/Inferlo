import { route } from "@browserlessapi/inferlo";
import { settings } from "../config.ts";

export const support = route.get("/support", { auth: "public" }).handle(() => ({ email: settings.SUPPORT_EMAIL }));
