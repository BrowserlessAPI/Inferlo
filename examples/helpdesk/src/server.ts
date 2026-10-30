import { env } from "../../../src/index.ts";
import { app } from "./app.ts";

await app.db.$sync();
const server = await app.listen(env.int("PORT", { default: 3000 }));
console.log(`helpdesk listening on http://localhost:${server.port}`);
