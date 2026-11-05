// Hono on Node.js through @hono/node-server, with the same body check as the Inferlo schema.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { validEcho } from "./checks.ts";

const app = new Hono();
app.get("/hello", (c) => c.json({ hello: "world" }));
app.post("/echo", async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (!validEcho(body)) return c.json({ error: "invalid body" }, 422);
  return c.json({ name: body.name, count: body.count });
});
serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: "127.0.0.1" }, () => process.send?.("ready"));
