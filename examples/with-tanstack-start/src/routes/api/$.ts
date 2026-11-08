// A splat server route for every request under /api: each method's handler runs the Inferlo app with /api removed.
import { createFileRoute } from "@tanstack/react-router";
import { toTanStackHandlers } from "../../../../../src/tanstack-start.ts";
import { app } from "../../inferlo/app.ts";

export const Route = createFileRoute("/api/$")({
  server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) },
});
