// Puts the AI client on every request as context.locals.ai (Astro.locals.ai in pages), for pages, endpoints and actions.
// To add your own middleware: export const onRequest = sequence(inferloAI(ai), yourMiddleware) (sequence from "astro:middleware").
import { inferloAI } from "../../../src/astro.ts";
import { ai } from "./lib/ai.ts";

export const onRequest = inferloAI(ai);
