// Express with express.json() and the same body check as the Inferlo schema.
import express from "express";
import { validEcho } from "./checks.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.get("/hello", (_req, res) => {
  res.json({ hello: "world" });
});
app.post("/echo", (req, res) => {
  const body: unknown = req.body;
  if (!validEcho(body)) {
    res.status(422).json({ error: "invalid body" });
    return;
  }
  res.json({ name: body.name, count: body.count });
});
app.listen(Number(process.env.PORT), "127.0.0.1", () => process.send?.("ready"));
