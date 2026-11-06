// Endpoints with prerender = false run on the server, so the project needs an adapter:
// npx astro add node (or vercel, netlify, cloudflare). Inferlo needs nothing else.
import { defineConfig } from "astro/config";

export default defineConfig({});
