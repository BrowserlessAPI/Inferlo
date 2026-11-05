import { toSvelteKitHandlers } from "@browserlessapi/inferlo/sveltekit";
import { app } from "../../../app.ts";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, fallback } = toSvelteKitHandlers(app, { prefix: "/api" });
