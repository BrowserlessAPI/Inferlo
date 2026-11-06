import { inferloAI } from "@browserlessapi/inferlo/astro";
import { app } from "./app.ts";

export const onRequest = inferloAI(app.ai);
