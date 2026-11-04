// The parts of an AdonisJS app (created with npm init adonisjs) that use Inferlo's AI module:
// this provider list, config/ai.ts and start/routes.ts. The test boots the app from these files.
import { defineConfig } from "@adonisjs/core/app";

export default defineConfig({
  providers: [
    () => import("@adonisjs/core/providers/app_provider"),
    // Binds config/ai.ts in the container as "ai" and adds ctx.ai to every HTTP context.
    // In your app: () => import("@browserlessapi/inferlo/adonisjs")
    () => import("../../src/adonisjs.ts"),
  ],
  preloads: [() => import("./start/routes.ts")],
});
