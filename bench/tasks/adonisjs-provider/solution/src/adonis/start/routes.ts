import router from "@adonisjs/core/services/router";

router.use([() => import("@adonisjs/core/bodyparser_middleware")]);

router.get("/", async () => ({ hello: "world" }));

router.post("/translate", async ({ ai, request }) => {
  const { text, to } = request.only(["text", "to"]);
  const result = await ai.generate({ model: "fast", prompt: `Translate into ${to}. Reply with the translation only.\n\n${text}` });
  return { translation: result.text };
});
