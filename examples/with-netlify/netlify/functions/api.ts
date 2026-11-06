// Netlify Function (Functions 2.0): the default export is called with (Request, Context), and app.fetch takes both.
import { app } from "../../src/app.ts";

export default app.fetch;

// Every path under /api/ goes to this function; the Request keeps the path the client asked for.
export const config = { path: "/api/*" };
