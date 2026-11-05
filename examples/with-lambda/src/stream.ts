// The Lambda handler for a function URL with InvokeMode RESPONSE_STREAM: AI answers reach the browser as they are generated.
import { toLambdaHandler } from "../../../src/lambda.ts";
import { app } from "./app.ts";

export const handler = toLambdaHandler(app, { streaming: true });
