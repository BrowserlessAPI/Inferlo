import { toAstroHandler } from "@browserlessapi/inferlo/astro";
import { app } from "../../app.ts";

export const prerender = false;
export const ALL = toAstroHandler(app, { prefix: "/api" });
