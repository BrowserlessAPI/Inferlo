import Fastify from "fastify";
import { inferloPlugin } from "@browserlessapi/inferlo/fastify";
import { app } from "./app.ts";

export async function buildServer() {
  const fastify = Fastify();
  fastify.get("/legacy", async (_request, reply) => reply.type("text/plain").send("fastify"));
  fastify.put<{ Params: { id: string } }>("/notes/:id", async (request) => ({ from: "fastify", id: request.params.id }));
  await fastify.register(inferloPlugin, { app, fallthrough: true });
  return fastify;
}
