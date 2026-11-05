// One HTTP-triggered function serves the whole Inferlo app: every path under /api, every method.
import { app as azure } from "@azure/functions";
import { toAzureHandler } from "../../../../src/azure.ts"; // in your project: "@browserlessapi/inferlo/azure"
import { app } from "../app.ts";

// Stream answers (AI streams included) as the app writes them, instead of after the last token.
azure.setup({ enableHttpStream: true });

// host.json keeps the default route prefix "api", so the app's /status is served at /api/status.
export const handler = toAzureHandler(app, { prefix: "/api" });

azure.http("inferlo", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});
