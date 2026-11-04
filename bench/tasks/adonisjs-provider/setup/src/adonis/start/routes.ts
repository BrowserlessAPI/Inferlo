import router from "@adonisjs/core/services/router";

router.use([() => import("@adonisjs/core/bodyparser_middleware")]);

router.get("/", async () => ({ hello: "world" }));
