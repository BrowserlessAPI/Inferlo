// Inferlo with its defaults (request ids, secure headers, validation), served by app.listen() on Node.js.
import { createApp, route, t } from "../../../src/index.ts";

const hello = route.get("/hello", { auth: "public" }).handle(() => ({ hello: "world" }));
const echo = route
  .post("/echo", { auth: "public", body: t.object({ name: t.string().min(1).max(100), count: t.int().min(0).max(1000) }) })
  .handle(({ body }) => ({ name: body.name, count: body.count }));

const app = createApp({ name: "perf", routes: [{ hello, echo }], openapi: false, logger: { info() {}, error() {} } });
await app.listen(Number(process.env.PORT), "127.0.0.1");
process.send?.("ready");
