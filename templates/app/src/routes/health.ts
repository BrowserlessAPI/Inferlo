import { route } from "@browserlessapi/inferlo";

export const health = route.get("/health", { auth: "public", summary: "Health check" }).handle(() => ({ ok: true }));
