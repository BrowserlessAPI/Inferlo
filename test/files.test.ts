import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, mockProvider, model, route, sessions, t } from "../src/index.ts";

const quiet = { info() {}, error() {} };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

const avatar = route
  .post("/avatar", {
    auth: "public",
    body: t.object({ avatar: t.file({ maxBytes: 1000, types: ["image/png", "image/jpeg"] }), caption: t.string().max(80).optional(), public: t.boolean().default(false) }),
  })
  .handle(async ({ body }) => ({ name: body.avatar.name, size: body.avatar.size, type: body.avatar.type, bytes: [...new Uint8Array(await body.avatar.arrayBuffer())].slice(0, 3), caption: body.caption ?? null, public: body.public }));

const attachments = route
  .post("/attachments", { auth: "public", body: t.object({ files: t.array(t.file({ maxBytes: 100 })).max(3), note: t.file({ types: ["text/*"] }).optional() }) })
  .handle(({ body }) => ({ names: body.files.map((f) => f.name), note: body.note?.name ?? null }));

function makeApp(config: Record<string, unknown> = {}) {
  return createApp({ routes: [{ avatar, attachments }], logger: quiet, ...config });
}

function form(entries: [string, string | Blob, string?][]): FormData {
  const data = new FormData();
  for (const [key, value, name] of entries) {
    if (typeof value === "string") data.append(key, value);
    else data.append(key, value, name);
  }
  return data;
}

describe("file uploads", () => {
  test("a multipart body gives the handler a File and coerces the other fields", async () => {
    const app = makeApp();
    const res = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob([PNG], { type: "image/png" }), "me.png"], ["caption", "Hello"], ["public", "true"]]) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "me.png", size: PNG.byteLength, type: "image/png", bytes: [0x89, 0x50, 0x4e], caption: "Hello", public: true });
  });

  test("a file larger than maxBytes is rejected with IL1001 before the handler runs", async () => {
    let ran = false;
    const app = createApp({
      logger: quiet,
      routes: [{ big: route.post("/big", { auth: "public", body: t.object({ file: t.file({ maxBytes: 10 }) }) }).handle(() => { ran = true; return {}; }) }],
    });
    const res = await app.request("/big", { method: "POST", body: form([["file", new Blob(["x".repeat(11)]), "a.txt"]]) });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.code, "IL1001");
    assert.equal(body.error.details[0].code, "file_too_large");
    assert.deepEqual(body.error.details[0].path, ["file"]);
    assert.equal(ran, false);
  });

  test("the whole upload is cut off at maxBodySize plus the files' maxBytes (IL2004, 413)", async () => {
    const app = makeApp({ maxBodySize: 1000 });
    // avatar allows 1000 bytes, so the limit is 2000 bytes for the whole body.
    const huge = new Uint8Array(5000);
    huge.set(PNG);
    const res = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob([huge], { type: "image/png" }), "me.png"]]) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "IL2004");
    // A streamed body without Content-Length is stopped while it is read.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) return controller.close();
        controller.enqueue(new Uint8Array(1000));
      },
    });
    const streamed = await app.fetch(new Request("http://x/avatar", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=abc" }, body: stream, duplex: "half" } as RequestInit));
    assert.equal(streamed.status, 413);
    assert.ok(pulled < 10, `read ${pulled} chunks`);
  });

  test("types limits the declared type, and the content must match it", async () => {
    const app = makeApp();
    const gif = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob(["GIF89a"], { type: "image/gif" }), "a.gif"]]) });
    assert.equal(gif.status, 422);
    assert.equal((await gif.json()).error.details[0].code, "file_type");
    // A script sent as image/png is rejected by its content.
    const spoofed = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "x.png"]]) });
    assert.equal(spoofed.status, 422);
    const details = (await spoofed.json()).error.details;
    assert.equal(details[0].code, "file_content");
    assert.match(details[0].message, /image\/png/);
    const jpeg = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob([JPEG], { type: "image/jpeg" }), "a.jpg"]]) });
    assert.equal(jpeg.status, 200);
  });

  test("lists of files, family types, and optional files left empty by the browser", async () => {
    const app = makeApp();
    const one = await app.request("/attachments", { method: "POST", body: form([["files", new Blob(["a"]), "a.txt"]]) });
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { names: ["a.txt"], note: null });
    const many = await app.request("/attachments", {
      method: "POST",
      body: form([["files", new Blob(["a"]), "a.txt"], ["files", new Blob(["b"]), "b.txt"], ["note", new Blob(["n"], { type: "text/markdown" }), "n.md"]]),
    });
    assert.deepEqual(await many.json(), { names: ["a.txt", "b.txt"], note: "n.md" });
    // An <input type="file"> with no file chosen sends an empty part with an empty filename: the same as leaving it out.
    const browser =
      '--b\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\na\r\n' +
      '--b\r\nContent-Disposition: form-data; name="note"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--b--\r\n';
    const empty = await app.request("/attachments", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=b" }, body: browser });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { names: ["a.txt"], note: null });
    const tooMany = await app.request("/attachments", { method: "POST", body: form([1, 2, 3, 4].map((i) => ["files", new Blob(["x"]), `${i}.txt`] as [string, Blob, string])) });
    assert.equal(tooMany.status, 422);
    assert.equal((await tooMany.json()).error.details[0].code, "too_long");
    const wrongType = await app.request("/attachments", { method: "POST", body: form([["files", new Blob(["a"]), "a.txt"], ["note", new Blob(["n"], { type: "application/json" }), "n.json"]]) });
    assert.equal((await wrongType.json()).error.details[0].code, "file_type");
  });

  test("a JSON body for a file route explains that files need multipart/form-data, and unknown fields are rejected", async () => {
    const app = makeApp();
    const res = await app.request("/avatar", { method: "POST", json: { avatar: "aGVsbG8=" } });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error.details[0].message, /multipart\/form-data/);
    const extra = await app.request("/avatar", { method: "POST", body: form([["avatar", new Blob([PNG], { type: "image/png" }), "me.png"], ["admin", "true"]]) });
    assert.equal(extra.status, 422);
    assert.equal((await extra.json()).error.details[0].code, "unknown_key");
    const missing = await app.request("/avatar", { method: "POST", body: form([["caption", "x"]]) });
    assert.equal((await missing.json()).error.details[0].code, "required");
  });

  test("a broken multipart body answers 400 IL2015", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://x/avatar", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz" }, body: "not multipart at all" }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "IL2015");
  });

  test("multipart bodies are only read as files on routes with t.file() fields", async () => {
    const app = createApp({ logger: quiet, routes: [{ plain: route.post("/plain", { auth: "public", body: t.object({ name: t.string() }) }).handle(({ body }) => body) }] });
    const res = await app.request("/plain", { method: "POST", body: form([["name", "x"]]) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "IL2003");
  });

  test("OpenAPI describes file bodies as multipart/form-data with the accepted types, and describe() names the body type", async () => {
    const app = makeApp();
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    const body = doc.paths["/avatar"].post.requestBody;
    assert.deepEqual(Object.keys(body.content), ["multipart/form-data"]);
    const media = body.content["multipart/form-data"];
    assert.deepEqual(media.schema.properties.avatar, { type: "string", format: "binary", "x-inferlo-max-bytes": 1000 });
    assert.deepEqual(media.encoding, { avatar: { contentType: "image/png, image/jpeg" } });
    assert.deepEqual(media.schema.required, ["avatar"]);
    const files = doc.paths["/attachments"].post.requestBody.content["multipart/form-data"].schema.properties.files;
    assert.deepEqual(files, { type: "array", items: { type: "string", format: "binary", "x-inferlo-max-bytes": 100 }, maxItems: 3 });
    const described = app.describe().routes.find((r) => r.path === "/avatar")!;
    assert.equal(described.bodyType, "multipart/form-data");
    assert.equal(app.describe().routes.find((r) => r.path === "/attachments")!.bodyType, "multipart/form-data");
  });

  test("t.file() options are checked when the schema is defined (IL1004)", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as InferloError).code;
      }
      return "no error";
    };
    assert.equal(code(() => t.file({ maxBytes: 0 })), "IL1004");
    assert.equal(code(() => t.file({ maxBytes: 1.5 })), "IL1004");
    assert.equal(code(() => t.file({ types: ["png"] })), "IL1004");
    assert.equal(code(() => t.file({ maxSize: 10 } as never)), "IL1004");
    assert.equal(t.file().def.max, 10 * 1024 * 1024);
    assert.equal(code(() => t.file({ types: ["IMAGE/PNG", "image/*"] })), "no error");
  });

  test("files are only allowed as top-level body fields, lists need .max(n), and file routes are not tools (IL1004)", () => {
    const code = (routes: Record<string, unknown>) => {
      try {
        createApp({ logger: quiet, routes: [routes] as never });
      } catch (error) {
        return (error as InferloError).code;
      }
      return "no error";
    };
    const r = (options: Record<string, unknown>) => ({ x: route.post("/x", { auth: "public", ...options } as never).handle(() => ({})) });
    assert.equal(code(r({ body: t.object({ files: t.array(t.file()) }) })), "IL1004");
    assert.equal(code(r({ body: t.object({ meta: t.object({ file: t.file() }) }) })), "IL1004");
    assert.equal(code(r({ query: t.object({ file: t.file() }) })), "IL1004");
    assert.equal(code(r({ body: t.object({ file: t.file() }), tool: true })), "IL1004");
    assert.equal(code(r({ body: t.object({ files: t.array(t.file()).max(2) }) })), "no error");
    assert.throws(() => model("photos", { file: t.file() }), (e: InferloError) => e.code === "IL1004");
  });

  test("a file route passed to ai.generate({ tools }) is refused (IL1004)", async () => {
    const ask = route.post("/ask", { auth: "public" }).handle(({ ai }) => ai.generate({ model: "fast", prompt: "hi", tools: [avatar] }));
    const app = createApp({ logger: quiet, routes: [{ avatar, ask }], ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } } });
    const res = await app.request("/ask", { method: "POST" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "IL1004");
  });

  test("sessions() reads the _csrf field of a multipart form before the files", async () => {
    const SECRET = "a-very-long-session-secret-for-tests-0123456789";
    const session = sessions({ secret: SECRET, user: ({ userId }) => ({ id: userId, roles: [] as string[] }) });
    const app = createApp({
      logger: quiet,
      auth: session,
      routes: [{
        login: route.post("/login", { auth: "public" }).handle((ctx) => session.signIn(ctx, "u1")),
        upload: route.post("/upload", { body: t.object({ file: t.file() }) }).handle(({ body, user }) => ({ name: body.file.name, by: user.id })),
      }],
    });
    const login = await app.fetch(new Request("https://app.example.com/login", { method: "POST" }));
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const post = (data: FormData) => app.fetch(new Request("https://app.example.com/upload", { method: "POST", headers: { cookie }, body: data }));
    const ok = await post(form([["_csrf", csrfToken], ["file", new Blob(["x".repeat(100_000)]), "big.txt"]]));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: "big.txt", by: "u1" });
    const missing = await post(form([["file", new Blob(["x"]), "a.txt"]]));
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, "IL3005");
    const wrong = await post(form([["_csrf", csrfToken.slice(1) + "A"], ["file", new Blob(["x"]), "a.txt"]]));
    assert.equal(wrong.status, 403);
  });
});
