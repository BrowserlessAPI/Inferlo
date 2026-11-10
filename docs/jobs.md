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

export const app = createApp({ models, routes: [notes], jobs: [jobs], ... });
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
- **Tenants** (multi-tenant apps, see [multi-tenancy](database.md#multi-tenancy)): a job queued by a request whose user has a tenant gets that tenant, and so do the jobs of events it publishes and the follow-ups a job queues. The job's `ctx.db` is scoped to it and `ctx.tenantId` names it. From `app.jobs`, pass it: `enqueue(job, input, { tenantId: "acme" })`; `{ tenantId: null }` queues a job without a tenant. The tenant is stored with the job in every store (`memory`, `database`, `redis`) and travels with events between services.
- `enqueue` returns the job record: `{ id, name, input, status, attempts, maxAttempts, runAt, lastError?, tenantId?, createdAt, updatedAt }`. `app.jobs.get(id)` reads it again. `status` is `"pending"`, `"running"`, `"done"` or `"failed"`.

## Handlers

The handler receives `{ input, db, ai, jobs, events, cache, audit, id, attempt, tenantId }` (`cache` is the app cache, see [Caching](caching.md)). `attempt` is 1 on the first run. `jobs.enqueue` inside a job queues follow-up jobs. There is no signed-in user: pass the user id in the input and use `for: userId` on AI calls. `ai.generate({ tools })` only works in route handlers (IL5009).

Throw to fail an attempt. A failed job runs again after 10 seconds, then 20, 40, and so on (at most one hour between attempts), until its retries are used up; then its status is `"failed"` and the error is logged. `lastError` holds the last error message. Make handlers safe to run twice: a retry runs the whole handler again.

## Running jobs

```ts
// src/server.ts
const server = await app.listen(Number(process.env.PORT ?? 3000));
app.jobs.start();                      // runs due jobs every second (pollMs: 1000)
process.on("SIGTERM", () => void app.close());   // stops the worker, waits for the running job
```

New projects do this in `src/server.ts`. `app.close()` stops every worker started with `app.jobs.start()` and waits for its running job, together with in-flight requests, then closes the server and the database (see [graceful shutdown](deploy.md#graceful-shutdown)). To stop only the jobs, keep the worker and call `await worker.stop()`.

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

## Events

An event says that something happened (`order.paid`, `note.deleted`). The code that publishes it does not know who reacts; jobs subscribe to it with `on(event, job)`. Each subscribed job runs in the background with the event's payload, with its own retries.

```ts
// src/events.ts
import { event, t } from "@browserlessapi/inferlo";

export const orderPaid = event("order.paid", {
  payload: t.object({ orderId: t.uuid(), amount: t.int().min(0) }),
  summary: "An order was paid",   // shown in describe
});
```

```ts
// src/jobs.ts
import { job, on } from "@browserlessapi/inferlo";
import { orderPaid } from "./events.ts";

export const sendReceipt = job("send-receipt", { input: orderPaid.payload }).handle(async ({ input, db }) => { ... });
export const addPoints = job("add-points", { input: orderPaid.payload }).handle(async ({ input, db }) => { ... });

export const subscriptions = [on(orderPaid, sendReceipt), on(orderPaid, addPoints)];
```

```ts
// in a route handler (or a job, with ctx.events), after the change is saved
await ctx.events.publish(orderPaid, { orderId: order.id, amount: order.total });
```

- `events.publish(event, payload)` validates the payload (a `ValidationError`, 422 in a route) and queues every job subscribed to the event (with a transport, see below, every service queues its own), then returns `{ id, name, publishedAt, jobs }` (the queued job ids). The jobs run like any job: in `app.jobs.start()` or `inferlo worker`, with retries, in the memory, database or Redis queue, and in `app.jobs.runDue()` in tests. Publishing an event no job subscribes to is fine: it queues nothing.
- `app.events.publish(...)` publishes from scripts and tests. In jobs, `ctx.events` is the same.
- Registering `on(event, job)` (in `createApp({ jobs })` or a module's `jobs`) registers its job too. Use the event's payload as the job's input (`input: orderPaid.payload`); a job whose input is an object with fewer fields gets only those fields, and a job that requires a field the payload does not have raises IL6032, as does an invalid event name, two different events with the same name, or the same job subscribed twice to one event.
- Each queued job's id is derived from the event id and the job name, so publishing the same event id again queues nothing new: pass `{ id }` to make publishing idempotent, for example with the id of the row the event comes from (`events.publish(orderPaid, payload, { id: order.id })`). Handlers should still be idempotent, since a job can run again after a crash.
- With `createApp({ tracing })`, the subscribed jobs continue the trace of the request that published the event.
- `app.events.list` and `app.events.subscriptions` list the events and subscriptions, and `inferlo describe` shows each event with its payload schema and jobs.

### Between services

With `createApp({ events: { transport } })`, published events go to every service with an `on(event, job)` subscription for them, through a message broker. Redis Streams is built in:

```ts
// in each service: shop (publishes order.paid), billing and mail (subscribe to it)
const redis = await createClient({ url: settings.REDIS_URL }).connect();   // from the redis package

export const app = createApp({
  name: "billing",                     // also the consumer group: one per service
  redis,
  jobs: [jobs],                        // on(orderPaid, createInvoice)
  events: { transport: "redis" },
});
```

- Share the event definitions between services (a small package or a shared folder), so publisher and subscribers check payloads with the same schema.
- `events.publish(event, payload)` validates the payload and sends it; it does not queue jobs itself. Every service, the publishing one too, queues the jobs of its own subscriptions when it receives the event. `publish` still returns the ids those jobs will have in this app.
- Services receive events while a worker runs (`app.jobs.start()` or `inferlo worker`), on every poll before due jobs run. `await app.events.receive()` receives the waiting events once (scripts and tests) and returns how many.
- Delivery is at least once: an event is acknowledged after its jobs are queued, and an event an instance read but did not acknowledge (it crashed) is delivered again after 30 seconds. Since job ids come from the event id, a repeated delivery queues nothing new.
- Each service gets each event once, however many instances it runs: the instances of one service (same `name`) share its events. That is why the Redis transport needs `createApp({ name })` (IL6033 without it).
- A service only gets the events published after it first received from the transport (its worker's first poll creates its consumer group), so start subscribers before you rely on their events.
- A received event whose payload does not match the subscriber's schema is logged with IL6034 (without the payload) and dropped, since delivering it again cannot help. Change payloads compatibly: add optional fields, and remove a field only after every subscriber stopped requiring it.
- With `createApp({ tracing })`, the trace of the publishing request travels with the event, so the subscribed jobs in other services are part of the same trace.
- `app.events.transport` is `"redis"` (or your transport's name), shown as `eventTransport` in `inferlo describe`. An unknown transport or option raises IL6033; `transport: "redis"` without `createApp({ redis })` raises IL6031.

Keys, trimming and the details of the Redis transport are in [Redis, "Events"](redis.md#events). Another broker can be used by passing an object that implements `EventTransport` (`{ name, send(message), receive(names, deliver) }`, and optionally `close()`, which `app.close()` calls after the job workers stopped). NATS JetStream, RabbitMQ and Kafka have transports in their own entry points (below).

### NATS JetStream

Services that already run NATS use `natsEventTransport` from `@browserlessapi/inferlo/nats` (needs `@nats-io/jetstream` 3 and a NATS connection, for example from `@nats-io/transport-node`; the server needs JetStream, `nats-server -js`, version 2.11 or later):

```ts
import { connect } from "@nats-io/transport-node";
import { natsEventTransport } from "@browserlessapi/inferlo/nats";

const nc = await connect({ servers: settings.NATS_URL });

export const app = createApp({
  name: "billing",
  jobs: [jobs],                        // on(orderPaid, createInvoice)
  events: { transport: natsEventTransport(nc, { service: "billing" }) },
});
```

- Events are published to the JetStream stream `INFERLO_EVENTS` (subjects `inferlo.events.<event name>`), created on first use with a 7-day `maxAgeMs` and a 2-minute duplicate window. The stream is shared by every service; create it yourself (same name and subjects) to choose replicas, storage or limits.
- Each service reads each event it subscribes to through its own durable pull consumer, `inferlo-<service>-<event name with "_" for ".">`, created at its first read with "deliver new". Instances of one service share its consumers, so each service gets each event once. Pass the app's name as `service`.
- An event is acknowledged after its jobs are queued. One whose delivery fails, or that an instance read without acknowledging (it stopped), is delivered again after `staleAfterMs` (default 30000). Publishing sets `Nats-Msg-Id` to the event id, so a repeated publish within the duplicate window is stored once; a repeated delivery queues nothing new either way.
- The rest works as with Redis: payloads are checked against the subscriber's schema (IL6034), the trace and the tenant travel with the event, and `app.events.transport` is `"nats"`. Invalid arguments raise IL6051.
- Options: `service` (required), `stream` (default `"INFERLO_EVENTS"`, the same in every service), `maxAgeMs` (used when the stream is created), `staleAfterMs`, `batch` (events read per event and poll, default 100). Close the NATS connection after `app.close()`.

### RabbitMQ

Services that already run RabbitMQ use `rabbitmqEventTransport` from `@browserlessapi/inferlo/rabbitmq` with a connection from [amqplib](https://amqp-node.github.io/amqplib/) (0.10.9 or later, promise API; RabbitMQ 4.3 or later):

```ts
import amqp from "amqplib";
import { rabbitmqEventTransport } from "@browserlessapi/inferlo/rabbitmq";

const connection = await amqp.connect(settings.RABBITMQ_URL);

export const app = createApp({
  name: "billing",
  jobs: [jobs],                        // on(orderPaid, createInvoice)
  events: { transport: rabbitmqEventTransport(connection, { service: "billing" }) },
});
```

- Events are published to the durable topic exchange `inferlo.events` with the event name as routing key, as persistent JSON messages with the event id as `messageId`. Publishing uses publisher confirms: `events.publish(...)` resolves when RabbitMQ has the event, and rejects when it refused it.
- Each service reads each event it subscribes to from its own durable queue, `inferlo.<service>.<event name>`, declared and bound at its first read (a quorum queue, or `queueType: "classic"`). Instances of one service share its queues, so each service gets each event once. Pass the app's name as `service`. A service only gets the events published after its first read.
- An event is acknowledged after its jobs are queued. One whose delivery fails (its jobs could not be queued) is returned to its queue after `staleAfterMs` (default 30000); the events an instance read without acknowledging are returned when its connection closes. A repeated delivery queues nothing new.
- RabbitMQ 4 drops a message from a quorum queue after 20 deliveries by default (about 10 minutes of failed deliveries with the default `staleAfterMs`). To keep events longer while a dependency is down, set a policy for the queues, for example `rabbitmqctl set_policy inferlo-events "^inferlo\." '{"delivery-limit": -1}' --apply-to quorum_queues`, or a `dead-letter-exchange` to keep them aside.
- Messages in the queues that are not Inferlo events are acknowledged and dropped. The rest works as with Redis: payloads are checked against the subscriber's schema (IL6034), the trace and the tenant travel with the event, and `app.events.transport` is `"rabbitmq"`. Invalid arguments raise IL6054.
- Options: `service` (required), `exchange` (default `"inferlo.events"`, the same in every service), `queueType` (`"quorum"` or `"classic"`), `staleAfterMs`, `batch` (events read per event and poll, default 100). Close the connection after `app.close()`.

### Kafka

Services that already run Apache Kafka (4.1 or later) use `kafkaEventTransport` from `@browserlessapi/inferlo/kafka` with a client from Confluent's [`@confluentinc/kafka-javascript`](https://github.com/confluentinc/confluent-kafka-javascript) (1.0.0 or later, its KafkaJS API; a native Node.js addon, so on Node.js):

```ts
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { kafkaEventTransport } from "@browserlessapi/inferlo/kafka";

const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: settings.KAFKA_BROKERS.split(",") } }); // plus ssl and sasl for a managed cluster

export const app = createApp({
  name: "billing",
  jobs: [jobs],                        // on(orderPaid, createInvoice)
  events: { transport: kafkaEventTransport(kafka, { service: "billing" }) },
});
```

- Each event name has its own topic, `inferlo.events.<event name>`, created the first time it is published or read (with `partitions`, or the broker's default number of partitions and replicas; create the topics yourself to choose more). Events are produced as JSON with the event id as key, and `events.publish(...)` resolves when the brokers acknowledged the event (all in-sync replicas).
- Each service reads the topics of the events it subscribes to as its own consumer group, `inferlo.<service>`, so each service gets each event once and its instances share the topics' partitions. Pass the app's name as `service`. A new group starts with the events published after it joined (it joins in the background on the first poll, which takes a few seconds), or with every event still in the topics with `fromBeginning: true`; afterwards it continues from its committed offsets.
- An event's offset is committed after its jobs are queued. One whose delivery fails (its jobs could not be queued) is delivered again after `staleAfterMs` (default 30000), and the events behind it on the same partition wait, so they keep their order. Events an instance read but did not deliver before it stopped are delivered by another instance of the service. A repeated delivery queues nothing new.
- `app.close()` disconnects the producer, consumer and admin client the transport created (there is no connection of yours to close). Messages in the topics that are not Inferlo events are skipped. The rest works as with Redis: payloads are checked against the subscriber's schema (IL6034), the trace and the tenant travel with the event, and `app.events.transport` is `"kafka"`. Invalid arguments raise IL6072.
- Options: `service` (required), `topicPrefix` (default `"inferlo.events."`, the same in every service), `partitions` (for topics the transport creates), `fromBeginning` (default false), `staleAfterMs`, `batch` (events delivered per poll, default 100).

## Where jobs are kept

By default the queue is kept in memory in the process that enqueues, so jobs are lost on restart and every instance runs its own. That is right for development and tests.

In production, keep jobs in the database (Postgres or MySQL) or Redis. In Postgres (MySQL works the same with `mysql()`):

```ts
export const app = createApp({
  db: postgres({ url: env("DATABASE_URL") }),
  jobs: [jobs],
  jobQueue: { store: "database" },     // default "memory"
});
```

- Jobs are stored in the table `inferlo_jobs`, created on first use (no migration needed). They survive restarts and deploys. With `createApp({ tracing })`, a job also stores the trace it was enqueued in, so its run shows up in the same trace (see [Observability, "Jobs"](observability.md#jobs)).
- Every instance shares the queue. Due jobs are claimed with `FOR UPDATE SKIP LOCKED`, so each attempt runs on exactly one instance, however many run `app.jobs.start()`.
- An instance only claims jobs it has registered, so during a rolling deploy an old instance never picks up a job that only the new code knows.
- While a job runs, its worker reports every 30 seconds that it is still alive. A job still `"running"` without a report for 5 minutes (its process crashed or was killed) is picked up again as its next attempt, with `lastError` saying the worker stopped. If it has no attempts left, it is marked `"failed"` instead. This is why handlers must be safe to run twice.
- `{ store: "database" }` needs the Postgres or MySQL adapter (IL6012). Any other store name raises IL6011.
- `app.jobs.get(id)` reads the record from the table, so any instance can check a job's status.

Or keep them in Redis, with the same guarantees:

```ts
const redis = await createClient({ url: settings.REDIS_URL }).connect();   // from the redis package

export const app = createApp({
  redis,
  jobs: [jobs],
  jobQueue: { store: "redis" },
});
```

- Each due job is claimed by one atomic Lua script, so each attempt runs on exactly one instance. Retries, backoff, the registered-jobs rule, the 30-second reports and the 5-minute stuck-job rule work as with the database queue; whether a job is stuck is decided with the Redis server's clock, so instances whose clocks differ agree.
- Pending and running jobs never expire. Finished jobs (`"done"` or `"failed"`) are kept for 7 days, so `app.jobs.get(id)` can report them, then Redis removes them.
- Cron ticks are queued once across instances, as with the database queue.
- `{ store: "redis" }` without `createApp({ redis })` raises IL6031. Keys and other details are in [Redis](redis.md#job-queue).

### BullMQ

Apps that already run [BullMQ](https://docs.bullmq.io) (5.0.0 or later) can keep Inferlo's jobs in a BullMQ queue, so they show up in the same dashboards (Bull Board, Taskforce.sh) and use the same Redis. Pass a `Queue` and a `Worker` of that queue without a processor to `bullmqJobStore` from `@browserlessapi/inferlo/bullmq`:

```ts
import { Queue, Worker } from "bullmq";
import { bullmqJobStore } from "@browserlessapi/inferlo/bullmq";

const connection = new IORedis(settings.REDIS_URL, { maxRetriesPerRequest: null });   // from the ioredis package
const queue = new Queue("inferlo", { connection });
const worker = new Worker("inferlo", null, { connection, autorun: false });

export const app = createApp({
  jobs: [jobs],
  jobQueue: { store: bullmqJobStore(queue, worker) },
});
```

- Every Inferlo job is a BullMQ job: its name is the job's name, its id is Inferlo's job id, and `runAt` is BullMQ's delay. Jobs queued with the same id (cron ticks, the jobs of an event delivered twice) are queued once, as with the other stores.
- Inferlo takes jobs with BullMQ's manual processing API in `app.jobs.start()`, `inferlo worker` and `app.jobs.runDue()`, and runs them with its own handlers, so input validation, retries with Inferlo's backoff (`moveToDelayed`), tracing, tenants, metrics and `onError` work as with the other stores. A finished job is `completed` or `failed` in BullMQ, kept for 7 days.
- While a job runs, its lock is extended every `lockDuration / 2` (the worker's option, default 30 seconds). A job whose process stopped is moved back by BullMQ's stalled-job check and runs again as its next attempt, with `lastError` saying the worker stopped, or is failed when it has no attempts left. BullMQ fails a job that stalled more than the worker's `maxStalledCount` times (default 1); raise it for long deploys. Handlers must be safe to run twice.
- Give Inferlo its own queue: a job in it that Inferlo did not queue is failed with a message, and BullMQ hands out jobs in order whatever their name, so a job that an older instance has not registered fails with IL6010 and is retried (deploy every instance with the same jobs). BullMQ decides when a job is due with its own clock, so `runDue({ now })` cannot run jobs early.
- The worker must belong to the same queue and be created with `autorun: false` and no processor, so only Inferlo takes its jobs; other arguments raise IL6057. Close the worker and the queue after `app.close()`.

## Testing

`app.jobs.runDue()` runs every due job now, one after another, including follow-ups they enqueue, and returns `{ done, retried, failed }`:

```ts
const res = await app.request("/notes", { method: "POST", json: { title: "Hi", body: "..." }, as: user });
assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
```

`runDue({ now })` runs the jobs that are due at that time, to test retries and `runAt` without waiting.

`inferlo describe` lists jobs with their retries and input schema, crons with their schedule, and events with their payload and subscribed jobs. To test the jobs of an event, publish it with `await app.events.publish(orderPaid, payload)`, then run `await app.jobs.runDue()`.
