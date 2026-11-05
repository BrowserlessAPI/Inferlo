import { app as azure } from "@azure/functions";
import { toAzureHandler } from "@browserlessapi/inferlo/azure";
import { app } from "../app.ts";

azure.setup({ enableHttpStream: true });

// host.json keeps the default route prefix "api", which the handler removes before the app routes the request.
export const handler = toAzureHandler(app, { prefix: "/api" });

azure.http("inferlo", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});
