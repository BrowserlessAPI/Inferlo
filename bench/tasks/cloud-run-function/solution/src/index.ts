import * as functions from "@google-cloud/functions-framework";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

functions.http("inferlo", toNodeHandler(app));
