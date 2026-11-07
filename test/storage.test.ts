// File storage (createApp({ storage })): memoryStorage() and diskStorage({ dir }) behave the same, keys are checked
// before any store sees them, and ctx.storage works in routes and jobs (Node.js, Bun and Deno).
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createApp, diskStorage, InferloError, job, memoryStorage, route, t, type StorageStore } from "../src/index.ts";
import { createStorage } from "../src/storage.ts";

const quiet = { info() {}, error() {} };
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inferlo-storage-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function storageContract(name: string, makeStore: () => Promise<StorageStore>) {
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

storageContract("memory", async () => memoryStorage());
storageContract("disk", async () => diskStorage({ dir: await tempDir() }));

describe("storage keys and types", () => {
  const storage = createStorage(memoryStorage());
  const bad = ["", "/abs.txt", "a//b", "a/", "../etc/passwd", "a/../b", "./a", ".env", "a/.hidden", "a\\b", "a b", "a/b?c", "a\0b", "x".repeat(256), `${"a/".repeat(600)}a`];
  for (const key of bad) {
    test(`rejects the key ${JSON.stringify(key.length > 30 ? key.slice(0, 30) + "..." : key)} with IL6039`, async () => {
      await assert.rejects(storage.put(key, "x"), isCode("IL6039"));
      await assert.rejects(storage.get(key), isCode("IL6039"));
      await assert.rejects(storage.delete(key), isCode("IL6039"));
    });
  }

  test("accepts keys of letters, digits, dots, dashes and underscores", async () => {
    for (const key of ["a", "avatars/42.png", "tenants/acme/users/u_1/report-2026.11.pdf", "A-Z_0.9"]) {
      await storage.put(key, "x");
      assert.equal(await (await storage.get(key))!.text(), "x");
    }
  });

  test("checks the media type and stores it in lower case without parameters from a Blob", async () => {
    await assert.rejects(storage.put("a.txt", "x", { type: "text/plain\r\nx-evil: 1" }), isCode("IL6039"));
    await assert.rejects(storage.put("a.txt", "x", { type: "nonsense" }), isCode("IL6039"));
    assert.equal((await storage.put("a.txt", "x", { type: "Text/Plain" })).type, "text/plain");
    assert.equal((await storage.put("b.txt", new Blob(["x"], { type: "text/plain;charset=utf-8" }))).type, "text/plain");
    await assert.rejects(storage.put("c.bin", 42 as never), isCode("IL6039"));
  });
});

describe("diskStorage", () => {
  test("keeps files on disk for the next process, with no temporary files left behind", async () => {
    const dir = await tempDir();
    await createStorage(diskStorage({ dir })).put("reports/q3.pdf", "%PDF-1.7", { type: "application/pdf" });
    const again = createStorage(diskStorage({ dir }));
    const file = (await again.get("reports/q3.pdf"))!;
    assert.equal(file.type, "application/pdf");
    assert.equal(await file.text(), "%PDF-1.7");
    assert.equal((await stat(join(dir, "reports", "q3.pdf"))).isFile(), true, "the file is at dir/key");
    assert.deepEqual(await readdir(join(dir, ".inferlo-tmp")), []);
  });

  test("a file placed in the directory by hand is read as application/octet-stream", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "imports"), { recursive: true });
    await writeFile(join(dir, "imports", "data.csv"), "a,b\n");
    const file = (await createStorage(diskStorage({ dir })).get("imports/data.csv"))!;
    assert.equal(file.type, "application/octet-stream");
    assert.equal(await file.text(), "a,b\n");
  });

  test("the metadata and temporary directories cannot be reached through keys", async () => {
    const dir = await tempDir();
    const storage = createStorage(diskStorage({ dir }));
    await storage.put("a.txt", "x", { type: "text/plain" });
    await assert.rejects(storage.get(".inferlo-meta/a.txt"), isCode("IL6039"));
    await assert.rejects(storage.get(".inferlo-tmp/a"), isCode("IL6039"));
  });

  test("needs a dir (IL6038)", () => {
    assert.throws(() => diskStorage({ dir: "" }), isCode("IL6038"));
    assert.throws(() => diskStorage(undefined as never), isCode("IL6038"));
  });

  test("concurrent writes to one key leave one whole file", async () => {
    const storage = createStorage(diskStorage({ dir: await tempDir() }));
    const bodies = Array.from({ length: 8 }, (_, i) => String(i).repeat(50_000));
    await Promise.all(bodies.map((body) => storage.put("race.txt", body, { type: "text/plain" })));
    assert.ok(bodies.includes(await (await storage.get("race.txt"))!.text()));
  });
});

describe("createApp({ storage })", () => {
  const upload = route
    .post("/me/avatar", { auth: "public", body: t.object({ avatar: t.file({ maxBytes: 1000, types: ["image/png"] }) }) })
    .handle(async ({ body, storage, jobs }) => {
      const saved = await storage.put("avatars/me.png", body.avatar);
      await jobs.enqueue(thumbnail, { key: saved.key });
      return saved;
    });
  const download = route.get("/me/avatar", { auth: "public" }).handle(async ({ storage }) => {
    const file = await storage.get("avatars/me.png");
    if (!file) return { found: false };
    return new Response(file, { headers: { "content-type": file.type } });
  });
  const thumbnail = job("thumbnail", { input: t.object({ key: t.string() }) }).handle(async ({ input, storage }) => {
    const file = await storage.get(input.key);
    await storage.put("thumbs/me.png", file!);
  });

  test("routes and jobs share ctx.storage, and app.storage is the same store", async () => {
    const app = createApp({ routes: [{ upload, download }], jobs: [thumbnail], storage: memoryStorage(), logger: quiet });
    const form = new FormData();
    form.append("avatar", new Blob([PNG], { type: "image/png" }), "me.png");
    const res = await app.request("/me/avatar", { method: "POST", body: form });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key: "avatars/me.png", size: PNG.byteLength, type: "image/png" });
    await app.jobs.runDue();
    assert.equal((await app.storage.get("thumbs/me.png"))!.size, PNG.byteLength);
    const got = await app.request("/me/avatar");
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
    assert.equal(app.storage.store, "memory");
    assert.equal(app.describe().storage, "memory");
  });

  test("without a storage option, ctx.storage answers 500 IL6037 and describe shows null", async () => {
    const app = createApp({ routes: [{ download }], logger: quiet });
    assert.equal(app.storage.store, null);
    assert.equal(app.describe().storage, null);
    await assert.rejects(app.storage.get("a.txt"), isCode("IL6037"));
    const res = await app.request("/me/avatar");
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "IL6037");
  });

  test("an invalid storage option fails at startup with IL6038", () => {
    for (const storage of [null, {}, { name: "x" }, "disk", { name: "", put() {}, get() {}, delete() {} }]) {
      assert.throws(() => createApp({ storage: storage as never, logger: quiet }), isCode("IL6038"));
    }
  });

  test("a custom store gets checked keys and the media type", async () => {
    const calls: string[] = [];
    const store: StorageStore = {
      name: "custom",
      async put(key, bytes, type) {
        calls.push(`put ${key} ${bytes.byteLength} ${type}`);
      },
      async get() {
        return null;
      },
      async delete() {
        return false;
      },
    };
    const app = createApp({ storage: store, logger: quiet });
    await app.storage.put("a/b.json", "{}", { type: "application/json" });
    await assert.rejects(app.storage.put("../b.json", "{}"), isCode("IL6039"));
    assert.deepEqual(calls, ["put a/b.json 2 application/json"]);
    assert.equal(app.describe().storage, "custom");
  });
});
