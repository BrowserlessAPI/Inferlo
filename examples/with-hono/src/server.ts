// Bun: bun src/server.ts. Deno: deno serve src/server.ts. Node: use @hono/node-server.
import { makeHono } from "./app.ts";

export default makeHono();
