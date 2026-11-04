import { app } from "./app.ts";

/** Graceful shutdown: /ready answers 503 at once, requests are served for 1 more second, then everything closes. */
export async function shutdown(): Promise<void> {
  await app.close({ delayMs: 1000 });
}
