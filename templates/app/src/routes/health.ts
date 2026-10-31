import { route } from "@browserlessapi/kairo";

export const health = route.get("/health", { auth: "public", summary: "Health check" }).handle(() => ({ ok: true }));
