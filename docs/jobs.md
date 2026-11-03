# Background jobs

Jobs run work after the response is sent, with retries: sending email, calling a slow AI model, processing an upload. A job is a plain value, like a route.

```ts
// src/jobs.ts
import { job, t } from "@browserlessapi/inferlo";

export const summarizeNote = job("summarize-note", {
  input: t.object({ noteId: t.uuid() }),
  retries: 3,              // default 3: up to 4 runs in total
  summary: "Write an AI summary of a note",
}).handle(async ({ input, db, ai, attempt }) => {
  const note = await db.notes.get(input.noteId);
  const { text } = await ai.generate({ model: "fast", prompt: `Summarize:\n\n${note.body}`, for: note.ownerId });
  await db.notes.update(note.id, { summary: text });
});
```

Register jobs in `createApp`, like routes:

```ts
import * as jobs from "./jobs.ts";

export const app = createApp({ models, routes: [health, notes], jobs: [jobs], ... });
```

## Enqueue

From a route handler, with `ctx.jobs`:

```ts
export const createNote = route
  .post("/notes", { body: Note.pick("title", "body") })
  .handle(async ({ body, user, db, jobs, status }) => {
    const note = await db.notes.insert({ ...body, ownerId: user.id });
    await jobs.enqueue(summarizeNote, { noteId: note.id });
    status(201);
    return note;
  });
```

Anywhere else, with `app.jobs.enqueue(job, input)`.

- Pass the job itself, not its name, so the input is typed and checked by TypeScript.
- The input is validated against the job's schema when it is enqueued (IL1001 if it does not match) and again when the job runs. It is stored as JSON, so pass ids, not rows: dates arrive as ISO strings and `t.date()` turns them back into `Date`.
- `enqueue(job, input, { runAt: new Date(Date.now() + 60_000) })` runs the job no earlier than `runAt`.
- `enqueue` returns the job record: `{ id, name, input, status, attempts, maxAttempts, runAt, lastError?, createdAt, updatedAt }`. `app.jobs.get(id)` reads it again. `status` is `"pending"`, `"running"`, `"done"` or `"failed"`.

## Handlers

The handler receives `{ input, db, ai, jobs, id, attempt }`. `attempt` is 1 on the first run. `jobs.enqueue` inside a job queues follow-up jobs. There is no signed-in user: pass the user id in the input and use `for: userId` on AI calls. `ai.generate({ tools })` only works in route handlers (IL5009).

Throw to fail an attempt. A failed job runs again after 10 seconds, then 20, 40, and so on (at most one hour between attempts), until its retries are used up; then its status is `"failed"` and the error is logged. `lastError` holds the last error message. Make handlers safe to run twice: a retry runs the whole handler again.

## Running jobs

```ts
// src/server.ts
const server = await app.listen(Number(process.env.PORT ?? 3000));
const worker = app.jobs.start();        // runs due jobs every second (pollMs: 1000)
process.on("SIGTERM", async () => {
  await worker.stop();                 // waits for the running job
  await server.close();
});
```

New projects do this in `src/server.ts`.

To run jobs in separate processes, keep them in the database (below) and start `inferlo worker` (`npm run worker` in new projects). It runs `app.jobs.start()` and, on SIGTERM or Ctrl+C, waits for the running job before it exits. Web servers and workers share the queue, so you can run jobs in both or only in workers. See [CLI](cli.md#inferlo-worker).

## Cron

`cron(schedule, job)` queues a job on a schedule. Export it next to the job; registering the module registers both:

```ts
// src/jobs.ts
import { cron, job, t } from "@browserlessapi/inferlo";

export const deleteOldSessions = job("delete-old-sessions", { input: t.object({}) }).handle(async ({ db }) => {
  await db.sessions.deleteMany({ expiresAt: { lt: new Date() } });
});

export const nightly = cron("0 3 * * *", deleteOldSessions);   // every day at 03:00 UTC
```

- The schedule has five fields, `minute hour day-of-month month day-of-week`, always in UTC: numbers, `*`, ranges (`1-5`), lists (`1,15`), steps (`*/15`, `5/20`) and names (`jan`, `mon`). Sunday is `0` or `7`. When both day fields are set, either one matching is enough, as in standard cron. Invalid schedules raise IL6013 when the module loads.
- `"*/15 * * * *"` every 15 minutes, `"0 * * * *"` every hour, `"30 3 * * 1-5"` at 03:30 on weekdays, `"0 0 1 * *"` on the first of each month.
- The job runs with the input `{}`, so its schema must accept it (IL6013 otherwise). Read what it needs from the database.
- Crons run while a worker runs: `app.jobs.start()` or `inferlo worker`. At each tick the job is queued and then runs like any other job, with its retries. Ticks are only queued after the worker started, and if the worker was paused past several ticks, only the latest one is queued.
- Each tick gets a fixed job id, so with the database queue every instance can run the schedule and the job is still queued once per tick.
- `cron.next(date)` returns the first tick after a date, and `app.jobs.crons` lists the crons. To test the work itself, enqueue the job: `await app.jobs.enqueue(deleteOldSessions, {})`, then `await app.jobs.runDue()`.

## Where jobs are kept

By default the queue is kept in memory in the process that enqueues, so jobs are lost on restart and every instance runs its own. That is right for development and tests.

In production, keep jobs in Postgres:

```ts
export const app = createApp({
  db: postgres({ url: env("DATABASE_URL") }),
  jobs: [jobs],
  jobQueue: { store: "database" },     // default "memory"
});
```

- Jobs are stored in the table `inferlo_jobs`, created on first use (no migration needed). They survive restarts and deploys.
- Every instance shares the queue. Due jobs are claimed with `FOR UPDATE SKIP LOCKED`, so each attempt runs on exactly one instance, however many run `app.jobs.start()`.
- An instance only claims jobs it has registered, so during a rolling deploy an old instance never picks up a job that only the new code knows.
- While a job runs, its worker reports every 30 seconds that it is still alive. A job still `"running"` without a report for 5 minutes (its process crashed or was killed) is picked up again as its next attempt, with `lastError` saying the worker stopped. If it has no attempts left, it is marked `"failed"` instead. This is why handlers must be safe to run twice.
- `{ store: "database" }` needs the Postgres adapter (IL6012). Any other store name raises IL6011.
- `app.jobs.get(id)` reads the record from the table, so any instance can check a job's status.

## Testing

`app.jobs.runDue()` runs every due job now, one after another, including follow-ups they enqueue, and returns `{ done, retried, failed }`:

```ts
const res = await app.request("/notes", { method: "POST", json: { title: "Hi", body: "..." }, as: user });
assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
```

`runDue({ now })` runs the jobs that are due at that time, to test retries and `runAt` without waiting.

`inferlo describe` lists jobs with their retries and input schema, and crons with their schedule.
