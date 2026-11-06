// Every request under /api (any method) runs through the Inferlo app, with /api removed from the path.
import { toAstroHandler } from "../../../../../src/astro.ts";
import { app } from "../../lib/inferlo.ts";

export const prerender = false;
export const ALL = toAstroHandler(app, { prefix: "/api" });
