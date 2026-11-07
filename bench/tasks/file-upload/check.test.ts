import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";
import { app } from "../src/app.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const user = { id: "00000000-0000-4000-8000-000000000001", email: "m@x.io", name: "M", roles: ["member"] };

function upload(file: Blob, name: string, alt?: string) {
  const form = new FormData();
  form.append("image", file, name);
  if (alt !== undefined) form.append("alt", alt);
  return form;
}

test("avatar uploads", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*avatars/, "registers the avatars routes");
  const png = new Blob([PNG], { type: "image/png" });
  assert.equal((await app.request("/me/avatar", { method: "POST", body: upload(png, "me.png") })).status, 401);
  const ok = await readJson(await app.request("/me/avatar", { method: "POST", body: upload(png, "me.png", "Me"), as: user }), 200);
  assert.deepEqual({ ...ok, type: String(ok.type).split(";")[0] }, { name: "me.png", size: PNG.byteLength, type: "image/png", alt: "Me" });
  const noAlt = await readJson(await app.request("/me/avatar", { method: "POST", body: upload(png, "me.png"), as: user }), 200);
  assert.equal(noAlt.alt, null);
  const big = new Uint8Array(1_000_001);
  big.set(PNG);
  assert.ok([413, 422].includes((await app.request("/me/avatar", { method: "POST", body: upload(new Blob([big], { type: "image/png" }), "big.png"), as: user })).status), "too large");
  assert.equal((await app.request("/me/avatar", { method: "POST", body: upload(new Blob(["hello"], { type: "text/plain" }), "a.txt"), as: user })).status, 422);
  assert.equal((await app.request("/me/avatar", { method: "POST", body: upload(new Blob(["<script>"], { type: "image/png" }), "x.png"), as: user })).status, 422);
  assert.equal((await app.request("/me/avatar", { method: "POST", body: upload(png, "me.png", "x".repeat(121)), as: user })).status, 422);
});
