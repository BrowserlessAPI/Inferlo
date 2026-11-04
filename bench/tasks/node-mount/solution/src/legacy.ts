import http from "node:http";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

const inferlo = toNodeHandler(app, { prefix: "/api" });

export function createLegacyServer(): http.Server {
  return http.createServer((req, res) =>
    inferlo(req, res, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("legacy");
    }),
  );
}
