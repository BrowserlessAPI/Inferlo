// The deno serve setup docs/deploy.md recommends (also how Deno Deploy runs an app): the module's default export
// has a fetch method, and an Inferlo app is one. Started by test/deno-serve.test.ts on Deno.
import { createApp, route, t } from "../../src/index.ts";

const app = createApp({
  name: "deno-serve-fixture",
  routes: [{ hello: route.get("/hello", { auth: "public", query: t.object({ name: t.string().default("world") }) }).handle(({ query }) => ({ hello: query.name })) }],
  logger: { info() {}, error() {} },
});

export default app;
