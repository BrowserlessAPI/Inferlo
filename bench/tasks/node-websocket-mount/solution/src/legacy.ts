import http from "node:http";
import { toNodeHandler, toNodeUpgradeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

const inferlo = toNodeHandler(app, { prefix: "/api" });

export function createLegacyServer(): http.Server {
  const server = http.createServer((req, res) =>
    inferlo(req, res, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("legacy");
    }),
  );
  // WebSocket upgrades are not requests: they arrive as "upgrade" events.
  server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/api" }));
  return server;
}
