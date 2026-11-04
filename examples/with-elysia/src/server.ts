// Bun: bun src/server.ts. Node: add the @elysiajs/node adapter (new Elysia({ adapter: node() })).
import { makeElysia } from "./app.ts";

makeElysia().listen(Number(process.env.PORT ?? 3000));
