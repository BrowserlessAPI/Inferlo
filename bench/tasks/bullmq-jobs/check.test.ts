import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { jobQueue } from "../src/job-queue.ts";

test("BullMQ job queue", () => {
  const source = readFileSync(new URL("../src/job-queue.ts", import.meta.url), "utf8");
  assert.match(source, /bullmqJobStore\(/, "uses Inferlo's BullMQ store");
  // Stand-ins for a BullMQ Queue and a Worker without a processor: the store talks to BullMQ only when jobs are queued or run.
  const queue = { name: "inferlo", add: async () => {}, getJob: async () => null };
  const worker = { name: "inferlo", opts: { autorun: false }, getNextJob: async () => undefined, startStalledCheckTimer: async () => {} };
  const app = createApp({ jobQueue: jobQueue(queue, worker) });
  assert.equal(app.jobs.queue, "bullmq");
  assert.equal(app.describe().jobQueue, "bullmq");
});
