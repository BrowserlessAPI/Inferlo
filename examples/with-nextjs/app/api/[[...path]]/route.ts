// Every request under /api goes to the Inferlo app, with /api removed: /api/summaries, /api/openapi.json, /api/mcp.
import { toNextHandlers } from "../../../../../src/nextjs.ts";
import { app } from "../../../inferlo/app.ts";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextHandlers(app, { prefix: "/api" });
