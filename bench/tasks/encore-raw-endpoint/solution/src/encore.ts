import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

// Encore passes the full path, so the prefix is removed before routing.
export const inferloHandler = toNodeHandler(app, { prefix: "/inferlo" });
