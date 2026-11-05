import { toNextHandlers } from "@browserlessapi/inferlo/nextjs";
import { app } from "../../../app.ts";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextHandlers(app, { prefix: "/api" });
