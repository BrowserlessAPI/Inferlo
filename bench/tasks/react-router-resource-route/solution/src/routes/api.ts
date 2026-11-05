import { toReactRouterHandlers } from "@browserlessapi/inferlo/react-router";
import { app } from "../app.ts";

export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" });
