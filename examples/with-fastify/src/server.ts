// node src/server.ts
import { makeServer } from "./app.ts";

const fastify = await makeServer();
const address = await fastify.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
console.log(`with-fastify running on ${address}`);
