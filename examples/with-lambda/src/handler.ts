// The Lambda handler for API Gateway (HTTP API or REST API) and function URLs with the BUFFERED invoke mode.
import { toLambdaHandler } from "../../../src/lambda.ts";
import { app } from "./app.ts";

export const handler = toLambdaHandler(app);
