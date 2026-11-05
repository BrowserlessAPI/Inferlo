import Hapi from "@hapi/hapi";
import { inferloPlugin } from "@browserlessapi/inferlo/hapi";
import { app } from "./app.ts";

export async function makeServer() {
  const server = Hapi.server({ port: 3000 });
  // The whole Inferlo app under /api; request.ai and server.ai default to app.ai.
  await server.register({ plugin: inferloPlugin, options: { app }, routes: { prefix: "/api" } });
  return server;
}
