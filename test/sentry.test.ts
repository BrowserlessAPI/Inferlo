// sentryOnError (@browserlessapi/inferlo/sentry) with the real @sentry/node SDK; events are captured in beforeSend
// instead of being sent. CI runs it on the oldest supported and the latest @sentry/node.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as Sentry from "@sentry/node";
import { bearer, createApp, InferloError, job, route, t } from "../src/index.ts";
import { sentryOnError } from "../src/sentry.ts";

const quiet = { info() {}, error() {} };
const events: any[] = [];
const auth = bearer((token) => (token === "ada-token" ? { id: "ada", email: "ada@example.com", roles: [], tenantId: "acme" } : null));

const waitForEvents = async (count: number) => {
  for (let i = 0; i < 100 && events.length < count; i++) await new Promise((r) => setTimeout(r, 10));
};

describe("sentryOnError", () => {
  before(() => {
    Sentry.init({
      dsn: "https://public@o0.ingest.sentry.io/0",
      defaultIntegrations: false,
      beforeSend(event) {
        events.push(event);
        return null; // never sent
      },
    } as Sentry.NodeOptions);
  });
  after(async () => {
    await Sentry.close(100);
  });

  test("a failed request is captured with tags, the user id and the inferlo context, redacted", async () => {
    events.length = 0;
    const app = createApp({
      routes: [
        route.get("/tickets/:id", { params: t.object({ id: t.string() }) }).handle(() => {
          throw new Error("could not reach postgres://app:hunter2hunter2@db:5432/app");
        }),
      ],
      auth,
      logger: quiet,
      onError: sentryOnError(Sentry),
    });
    const res = await app.fetch(new Request("http://localhost/tickets/42", { headers: { authorization: "Bearer ada-token" } }));
    assert.equal(res.status, 500);
    await waitForEvents(1);
    assert.equal(events.length, 1);
    const event = events[0];
    const exception = event.exception.values.at(-1);
    assert.equal(exception.type, "Error");
    assert.match(exception.value, /postgres:\/\/app:\[redacted\]@db/);
    assert.doesNotMatch(JSON.stringify(event), /hunter2hunter2/);
    assert.equal(event.tags["inferlo.source"], "request");
    assert.equal(event.tags["inferlo.route"], "/tickets/:id");
    assert.equal(event.tags.request_id, res.headers.get("x-request-id"));
    assert.equal(event.tags.tenant_id, "acme");
    assert.deepEqual(event.user, { id: "ada" }, "only the user id, never the email");
    assert.equal(event.contexts.inferlo.path, "/tickets/42");
    assert.equal(event.contexts.inferlo.method, "GET");
  });

  test("failed job attempts are captured with the job tags", async () => {
    events.length = 0;
    const sync = job("sync-crm", { input: t.object({}), retries: 0 }).handle(() => {
      throw new Error("CRM timeout");
    });
    const app = createApp({ jobs: [sync], logger: quiet, onError: sentryOnError(Sentry) });
    await app.jobs.enqueue(sync, {});
    await app.jobs.runDue();
    await waitForEvents(1);
    assert.equal(events.length, 1);
    assert.equal(events[0].exception.values.at(-1).value, "CRM timeout");
    assert.equal(events[0].tags["inferlo.source"], "job");
    assert.equal(events[0].tags["inferlo.job"], "sync-crm");
    assert.equal(events[0].tags["inferlo.final"], "true");
    assert.equal(events[0].contexts.inferlo.attempt, 1);
    assert.equal(events[0].user, undefined);
  });

  test("client errors are not captured", async () => {
    events.length = 0;
    const app = createApp({ routes: [route.get("/x", { auth: "public" }).handle(() => "x")], logger: quiet, onError: sentryOnError(Sentry) });
    assert.equal((await app.fetch(new Request("http://localhost/nope"))).status, 404);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, 0);
  });

  test("anything without captureException raises IL6056", () => {
    for (const value of [undefined, null, {}, "Sentry", { captureMessage() {} }]) {
      assert.throws(() => sentryOnError(value as never), (e: unknown) => e instanceof InferloError && e.code === "IL6056");
    }
  });
});
