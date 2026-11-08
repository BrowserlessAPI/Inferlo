import { createFileRoute } from "@tanstack/react-router";
import { toTanStackHandlers } from "@browserlessapi/inferlo/tanstack-start";
import { app } from "../../app.ts";

export const Route = createFileRoute("/api/$")({
  server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) },
});
