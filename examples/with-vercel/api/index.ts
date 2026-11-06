// Vercel Function (Node.js runtime): a default export with fetch is the web-standard handler, so the app is the function.
// vercel.json sends every path to this function; the Request keeps the path the client asked for.
import { app } from "../src/app.ts";

export default app;
