import { toLambdaHandler } from "@browserlessapi/inferlo/lambda";
import { app } from "./app.ts";

export const handler = toLambdaHandler(app);
