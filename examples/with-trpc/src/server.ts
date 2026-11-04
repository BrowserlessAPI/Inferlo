// node src/server.ts (or bun src/server.ts): the tRPC API on http://localhost:3000/trpc.
import { serve } from "../../../src/index.ts";
import { makeHandler } from "./app.ts";

await serve({ fetch: makeHandler() }, { port: Number(process.env.PORT ?? 3000) });
