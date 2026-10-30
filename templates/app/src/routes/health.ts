import { route } from "kairojs";

export const health = route.get("/health", { auth: "public", summary: "Health check" }).handle(() => ({ ok: true }));
