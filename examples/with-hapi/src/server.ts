// node src/server.ts
import { makeServer } from "./app.ts";

const server = await makeServer(undefined, Number(process.env.PORT ?? 3000));
await server.start();
console.log(`with-hapi running on ${server.info.uri}`);
