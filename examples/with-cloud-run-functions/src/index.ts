// The Cloud Run function: the Functions Framework calls it for every request, and the Inferlo app answers.
// Deploy with: gcloud run deploy with-cloud-run-functions --source . --function inferlo --base-image nodejs22
import * as functions from "@google-cloud/functions-framework";
import { toNodeHandler } from "../../../src/index.ts"; // in your project: "@browserlessapi/inferlo"
import { app } from "./app.ts";

functions.http("inferlo", toNodeHandler(app));
