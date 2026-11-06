import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

process.env.BILLING_TOKEN = "billing-secret-token";

test("GET /limits asks the billing service for the user's plan", async () => {
  const plans = new Map<string, "free" | "pro">();
  const calls: { url: string; authorization: string | null; requestId: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, authorization: req.headers.get("authorization"), requestId: req.headers.get("x-request-id") });
    const match = /^http:\/\/billing\.internal\/accounts\/([^/]+)\/plan$/.exec(req.url);
    const plan = match ? plans.get(decodeURIComponent(match[1]!)) : undefined;
    if (!plan) return Response.json({ error: { code: "IL4001", message: "Not found" } }, { status: 404 });
    return Response.json({ plan, renewsAt: null });
  }) as typeof fetch;
  try {
    const routes = await import("../src/routes/limits.ts");
    const app = createApp({ models, routes: [routes], db: memory(), auth: { resolve: () => null } });
    const pro = await app.db.users.insert({ email: "p@x.io", name: "P" });
    const free = await app.db.users.insert({ email: "f@x.io", name: "F" });
    plans.set(pro.id, "pro");
    const as = (u: typeof pro) => ({ id: u.id, email: u.email, name: u.name, roles: [] });

    const res = await app.request("/limits", { as: as(pro) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { plan: "pro", maxNotes: 1000 });
    assert.equal(calls.at(-1)?.url, `http://billing.internal/accounts/${pro.id}/plan`);
    assert.equal(calls.at(-1)?.authorization, "Bearer billing-secret-token");
    assert.equal(calls.at(-1)?.requestId, res.headers.get("x-request-id"), "the request id is forwarded");

    const other = await app.request("/limits", { as: as(free) });
    assert.deepEqual(await other.json(), { plan: "free", maxNotes: 10 }, "a 404 from billing means the free plan");

    plans.clear();
    globalThis.fetch = (async () => Response.json({ error: { code: "IL9000", message: "boom" } }, { status: 500 })) as typeof fetch;
    assert.equal((await app.request("/limits", { as: as(pro) })).status, 502, "other billing errors are not hidden");
  } finally {
    globalThis.fetch = realFetch;
  }
});
