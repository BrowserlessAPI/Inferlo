import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";
import { app } from "../src/app.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const ada = { id: "00000000-0000-4000-8000-000000000001", email: "a@x.io", name: "A", roles: ["member"] };
const bob = { id: "00000000-0000-4000-8000-000000000002", email: "b@x.io", name: "B", roles: ["member"] };

function upload(file: Blob) {
  const form = new FormData();
  form.append("image", file, "me.png");
  return form;
}

test("avatar storage", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*avatars/, "registers the avatars routes");
  const png = new Blob([PNG], { type: "image/png" });
  assert.equal((await app.request("/me/avatar", { method: "PUT", body: upload(png) })).status, 401);
  assert.equal((await app.request("/me/avatar", { as: ada })).status, 404);
  const saved = await readJson(await app.request("/me/avatar", { method: "PUT", body: upload(png), as: ada }), 200);
  assert.deepEqual(saved, { key: `avatars/${ada.id}`, size: PNG.byteLength, type: "image/png" });
  const res = await app.request("/me/avatar", { as: ada });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  assert.equal((await app.request("/me/avatar", { as: bob })).status, 404, "each user has their own avatar");
  assert.equal((await app.storage.get(`avatars/${ada.id}`))?.size, PNG.byteLength);
  assert.equal((await app.request("/me/avatar", { method: "PUT", body: upload(new Blob(["<svg/>"], { type: "image/svg+xml" })), as: ada })).status, 422);
});
