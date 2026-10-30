/**
 * Test helpers.
 *
 *   import { readJson } from "@kairojs/core/testing"
 *   const res = await app.request("/tickets", { method: "POST", json: { title: "Hi" }, as: user })
 *   const data = await readJson(res, 200)
 */
export { mockProvider } from "./ai/providers.ts";
export { memory } from "./db/memory.ts";

/** Parse a JSON response and assert its status, with the body in the error message on mismatch. */
export async function readJson<T = any>(response: Response, expectedStatus?: number): Promise<T> {
  const text = await response.text();
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Collect server-sent events from a streaming response. */
export async function readEvents(response: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data === undefined ? undefined : JSON.parse(data) };
    });
}
