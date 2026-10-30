import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { model, t, ValidationError } from "../src/index.ts";

describe("schema", () => {
  test("parses valid objects and applies defaults", () => {
    const s = t.object({ name: t.string().max(5), tags: t.array(t.string()).default(() => []), age: t.int().optional() });
    assert.deepEqual(s.parse({ name: "Asha" }), { name: "Asha", tags: [] });
  });

  test("rejects unknown keys with a did-you-mean hint", () => {
    const s = t.object({ priority: t.enum(["low", "high"]) });
    const r = s.safeParse({ priority: "low", prio: "x" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.issues[0]!.code, "unknown_key");
      assert.match(r.issues[0]!.message, /Did you mean "priority"/);
    }
  });

  test("strip() drops unknown keys", () => {
    assert.deepEqual(t.object({ a: t.int() }).strip().parse({ a: 1, b: 2 }), { a: 1 });
  });

  test("enum suggests the closest value", () => {
    const r = t.enum(["urgent", "normal"]).safeParse("urgnt");
    assert.ok(!r.ok && /Did you mean "urgent"/.test(r.issues[0]!.message));
  });

  test("string, number, email, url, uuid and date checks", () => {
    assert.equal(t.string().min(2).safeParse("a").ok, false);
    assert.equal(t.int().safeParse(1.5).ok, false);
    assert.equal(t.number().max(3).safeParse(4).ok, false);
    assert.equal(t.email().safeParse("x@y.io").ok, true);
    assert.equal(t.email().safeParse("nope").ok, false);
    assert.equal(t.url().safeParse("javascript:alert(1)").ok, false);
    assert.equal(t.uuid().safeParse("8f14e45f-ceea-467f-a0d6-2f1f4f1b9a9c").ok, true);
    const d = t.date().parse("2026-10-30T10:00:00Z");
    assert.ok(d instanceof Date);
    assert.equal(t.date().safeParse("yesterday").ok, false);
  });

  test("coerce converts query string values", () => {
    const s = t.object({ page: t.int(), open: t.boolean(), ids: t.array(t.string()) });
    assert.deepEqual(s.parse({ page: "2", open: "true", ids: "a,b" }, { coerce: true }), { page: 2, open: true, ids: ["a", "b"] });
  });

  test("parse throws ValidationError with KR1001 and paths", () => {
    const s = t.object({ user: t.object({ age: t.int() }) });
    try {
      s.parse({ user: { age: "x" } });
      assert.fail("should throw");
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, "KR1001");
      assert.equal(error.status, 422);
      assert.deepEqual(error.issues[0]!.path, ["user", "age"]);
    }
  });

  test("nullable and optional", () => {
    assert.equal(t.string().nullable().parse(null), null);
    assert.equal(t.string().optional().parse(undefined), undefined);
    assert.equal(t.string().safeParse(null).ok, false);
  });

  test("pick, omit, partial, extend", () => {
    const s = t.object({ a: t.int(), b: t.string(), c: t.boolean() });
    assert.deepEqual(Object.keys(s.pick("a", "b").shape), ["a", "b"]);
    assert.deepEqual(Object.keys(s.omit("a").shape), ["b", "c"]);
    assert.deepEqual(s.partial().parse({}), {});
    assert.deepEqual(Object.keys(s.extend({ d: t.int() }).shape), ["a", "b", "c", "d"]);
    assert.throws(() => (s as any).pick("zz"), /KR1003|does not exist/);
  });

  test("JSON Schema output", () => {
    const s = t.object({
      title: t.string().max(10).describe("Title"),
      level: t.enum(["a", "b"]).default("a"),
      note: t.string().nullable().optional(),
    });
    assert.deepEqual(s.toJSONSchema(), {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 10, description: "Title" },
        level: { type: "string", enum: ["a", "b"], default: "a" },
        note: { type: ["string", "null"] },
      },
      required: ["title"],
      additionalProperties: false,
    });
  });

  test("models reject system fields in input and bad names", () => {
    const M = model("notes", { text: t.string() });
    const r = M.create.safeParse({ text: "x", id: "abc" });
    assert.equal(r.ok, false);
    assert.throws(() => model("Bad Name", {}), /KR4005/);
    assert.throws(() => model("things", { id: t.string() }), /KR4006/);
  });
});
