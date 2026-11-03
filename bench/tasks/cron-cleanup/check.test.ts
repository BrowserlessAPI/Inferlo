import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("a cron runs a job at 03:00 UTC every day that deletes notes with an empty body", async () => {
  const daily = app.jobs.crons.find(
    (c) =>
      c.next(new Date("2030-01-01T00:00:00Z")).toISOString() === "2030-01-01T03:00:00.000Z" &&
      c.next(new Date("2030-01-01T03:00:00Z")).toISOString() === "2030-01-02T03:00:00.000Z" &&
      c.next(new Date("2030-01-04T12:00:00Z")).toISOString() === "2030-01-05T03:00:00.000Z",
  );
  assert.ok(daily, "register a cron that runs every day at 03:00 UTC in createApp({ jobs })");
  const user = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const keep = await app.db.notes.insert({ title: "Keep", body: "text", ownerId: user.id });
  await app.db.notes.insert({ title: "Empty", body: "", ownerId: user.id });
  await app.db.notes.insert({ title: "Empty too", ownerId: user.id });
  await app.jobs.enqueue(daily.job, {});
  const result = await app.jobs.runDue();
  assert.equal(result.done, 1);
  assert.deepEqual((await app.db.notes.findMany()).map((n) => n.id), [keep.id]);
});
