import http from "node:http";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

// Inferlo answers the routes it has; everything else falls through to the old service.
const inferlo = toNodeHandler(app, { fallthrough: true });

export function createLegacyServer(): http.Server {
  return http.createServer((req, res) => {
    void inferlo(req, res, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("legacy");
    });
  });
}
