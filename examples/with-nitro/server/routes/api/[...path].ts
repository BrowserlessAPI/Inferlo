// Every request under /api goes to the Inferlo app, with /api removed from the path:
// POST /api/summaries, GET /api/openapi.json and POST /api/mcp.
import { toH3Handler } from "../../../../../src/h3.ts";
import { app } from "../../inferlo/app.ts";

export default toH3Handler(app, { prefix: "/api" });
