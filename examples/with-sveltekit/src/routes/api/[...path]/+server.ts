// Every request under /api (any method) runs through the Inferlo app, with /api removed from the path.
import { toSvelteKitHandlers } from "../../../../../../src/sveltekit.ts";
import { app } from "../../../lib/server/inferlo.ts";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, fallback } = toSvelteKitHandlers(app, { prefix: "/api" });
