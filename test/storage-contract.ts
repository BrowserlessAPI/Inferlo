// The behaviour every StorageStore must have, shared by the memory, disk and S3 store tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StorageStore } from "../src/index.ts";
import { createStorage } from "../src/storage.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

export function storageContract(name: string, makeStore: () => Promise<StorageStore>) {
  describe(`storage (${name} store)`, () => {
    test("put, get and delete; missing keys are null and false", async () => {
      const storage = createStorage(await makeStore());
      assert.equal(await storage.get("missing.txt"), null);
      const saved = await storage.put("avatars/42.png", new File([PNG], "me.png", { type: "image/png" }));
      assert.deepEqual(saved, { key: "avatars/42.png", size: PNG.byteLength, type: "image/png" });
      const file = await storage.get("avatars/42.png");
      assert.ok(file instanceof File);
      assert.equal(file.name, "42.png");
      assert.equal(file.type, "image/png");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);
      assert.equal(await storage.delete("avatars/42.png"), true);
      assert.equal(await storage.get("avatars/42.png"), null);
      assert.equal(await storage.delete("avatars/42.png"), false);
    });

    test("put replaces the file and its type; text, bytes and ArrayBuffers are accepted", async () => {
      const storage = createStorage(await makeStore());
      await storage.put("notes/a.txt", "first", { type: "text/plain" });
      assert.deepEqual(await storage.put("notes/a.txt", "{\"n\":1}", { type: "application/json" }), { key: "notes/a.txt", size: 7, type: "application/json" });
      const file = (await storage.get("notes/a.txt"))!;
      assert.equal(file.type.split(";")[0], "application/json", "Bun's File adds ;charset=utf-8 to JSON types");
      assert.equal(await file.text(), '{"n":1}');
      await storage.put("raw/bytes.bin", new Uint8Array([1, 2, 3]));
      assert.equal((await storage.get("raw/bytes.bin"))!.type, "application/octet-stream", "no type: application/octet-stream");
      await storage.put("raw/buffer.bin", new Uint8Array([4, 5]).buffer);
      assert.deepEqual(new Uint8Array(await (await storage.get("raw/buffer.bin"))!.arrayBuffer()), new Uint8Array([4, 5]));
    });

    test("the stored bytes do not change when the caller changes its copy", async () => {
      const storage = createStorage(await makeStore());
      const bytes = new Uint8Array([1, 2, 3]);
      await storage.put("copy.bin", bytes);
      bytes[0] = 9;
      const read = new Uint8Array(await (await storage.get("copy.bin"))!.arrayBuffer());
      assert.deepEqual(read, new Uint8Array([1, 2, 3]));
      read[1] = 9;
      assert.deepEqual(new Uint8Array(await (await storage.get("copy.bin"))!.arrayBuffer()), new Uint8Array([1, 2, 3]));
    });

    test("a prefix of other keys is not a file", async () => {
      const storage = createStorage(await makeStore());
      await storage.put("tenants/acme/a.txt", "a");
      assert.equal(await storage.get("tenants/acme"), null);
      assert.equal(await storage.delete("tenants/acme"), false);
      assert.equal(await (await storage.get("tenants/acme/a.txt"))!.text(), "a");
    });

    test("empty files are files", async () => {
      const storage = createStorage(await makeStore());
      assert.equal((await storage.put("empty.txt", "", { type: "text/plain" })).size, 0);
      const file = await storage.get("empty.txt");
      assert.ok(file);
      assert.equal(file.size, 0);
    });
  });
}

