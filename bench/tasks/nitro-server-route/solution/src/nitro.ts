import { inferloAI, toH3Handler } from "@browserlessapi/inferlo/h3";
import { app } from "./app.ts";

export const apiRoute = toH3Handler(app, { prefix: "/api" });

export const aiPlugin = inferloAI(app.ai);
