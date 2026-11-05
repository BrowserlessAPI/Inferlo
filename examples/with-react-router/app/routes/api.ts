// A resource route (no default export) for every request under /api, declared in app/routes.ts as
// route("api/*", "routes/api.ts"). GET and HEAD reach the loader, other methods the action.
import { toReactRouterHandlers } from "../../../../src/react-router.ts";
import { app } from "../inferlo/app.server.ts";

export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" });
