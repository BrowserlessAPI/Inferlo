// Fastify with a JSON schema for the body (its built-in validation).
import Fastify from "fastify";

const app = Fastify({ logger: false });
app.get("/hello", async () => ({ hello: "world" }));
app.post(
  "/echo",
  {
    schema: {
      body: {
        type: "object",
        required: ["name", "count"],
        additionalProperties: false,
        properties: { name: { type: "string", minLength: 1, maxLength: 100 }, count: { type: "integer", minimum: 0, maximum: 1000 } },
      },
    },
  },
  async (request) => {
    const body = request.body as { name: string; count: number };
    return { name: body.name, count: body.count };
  },
);
await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
process.send?.("ready");
