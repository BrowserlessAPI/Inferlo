// Puts the AI client on every request as event.locals.ai, for load functions, form actions and +server.ts files.
// To add your own hooks: export const handle = sequence(inferloAI(ai), yourHandle) (sequence from "@sveltejs/kit/hooks").
import { inferloAI } from "../../../src/sveltekit.ts";
import { ai } from "./lib/server/ai.ts";

export const handle = inferloAI(ai);
