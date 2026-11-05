import { inferloAI } from "@browserlessapi/inferlo/sveltekit";
import { app } from "./app.ts";

export const handle = inferloAI(app.ai);
