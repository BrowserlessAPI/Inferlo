// Netlify Function (Functions 2.0): Netlify calls the default export with (Request, Context), the signature of app.fetch.
import { app } from "../../src/app.ts";

export default app.fetch;

export const config = { path: "/*" };
