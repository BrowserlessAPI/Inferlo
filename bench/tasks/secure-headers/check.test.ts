import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

const directives = (csp: string | null) => new Map((csp ?? "").split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d.split(/\s+/).slice(1).sort().join(" ")]));

test("only the app and https://partner.example.com may frame the app", async () => {
  for (const path of ["/health", "/notes", "/missing"]) {
    const res = await app.fetch(new Request(`https://api.example${path}`));
    const csp = directives(res.headers.get("content-security-policy"));
    assert.equal(csp.get("frame-ancestors"), "'self' https://partner.example.com", path);
    assert.equal(csp.get("default-src"), "'self'");
    assert.equal(csp.get("object-src"), "'none'");
    assert.equal(csp.get("base-uri"), "'self'");
    assert.equal(csp.get("form-action"), "'self'");
    assert.equal(res.headers.get("x-frame-options"), null, "X-Frame-Options is dropped");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  }
});
