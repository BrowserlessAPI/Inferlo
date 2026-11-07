# File storage

`ctx.storage` keeps files, such as uploads from [`t.file()`](routes.md#file-uploads), in the store chosen in `createApp({ storage })`. It works the same in routes, WebSocket handlers and jobs, and as `app.storage` everywhere else.

```ts
import { createApp, diskStorage, env, route, t } from "@browserlessapi/inferlo";

export const uploadAvatar = route
  .post("/me/avatar", { body: t.object({ avatar: t.file({ maxBytes: 2_000_000, types: ["image/png", "image/jpeg"] }) }) })
  .handle(async ({ body, user, storage, db }) => {
    const saved = await storage.put(`avatars/${user.id}`, body.avatar); // { key, size, type }
    await db.users.update(user.id, { avatarKey: saved.key });
    return saved;
  });

export const app = createApp({
  routes,
  storage: diskStorage({ dir: env("UPLOADS_DIR", { default: "./uploads" }) }),
});
```

## Stores

| Store | Use it for |
|---|---|
| `memoryStorage()` | Tests and single-process development. Files are lost on restart. |
| `diskStorage({ dir })` | A local disk, or a volume every instance mounts (NFS, EFS, a Kubernetes persistent volume). Node.js, Bun and Deno. The directory is created on first write. |
| Your own `StorageStore` | Any other store: an object with `name`, `put(key, bytes, type)`, `get(key)` (resolves to `{ bytes, type }` or `null`) and `delete(key)` (resolves to `true` when the key existed). |

An S3-compatible store (AWS S3, Cloudflare R2, MinIO) with signed download URLs is planned next.

Without a `storage` option, `ctx.storage` throws IL6037 (a 500 in routes), so files are never kept somewhere you did not choose. An invalid option fails at startup with IL6038.

## The API

| Call | Result |
|---|---|
| `await storage.put(key, data, { type })` | Stores `data` (a `File` from `t.file()`, a `Blob`, a `Uint8Array`, an `ArrayBuffer` or a string) under `key`, replacing what was there. Resolves to `{ key, size, type }`. |
| `await storage.get(key)` | The file as a web `File` (`name` is the key's last segment, `type` the stored media type), or `null`. |
| `await storage.delete(key)` | Removes the file. Resolves to `true` when it existed, `false` otherwise. |
| `storage.store` | The store's name (`"memory"`, `"disk"` or your store's `name`), or `null` without a storage option. `inferlo describe` shows it as `storage`. |

- The media type is `{ type }` when given, else the `File`'s or `Blob`'s type without parameters, else `application/octet-stream`. It must be a plain media type such as `image/png` (lower-cased when stored); anything else is IL6039.
- Keys are segments of letters, digits, `.`, `_` and `-`, separated by `/`, up to 1024 characters: `avatars/42.png`, `tenants/acme/reports/2026-11.pdf`. A segment cannot start with `.` and cannot be empty, so `..`, `/etc/passwd`, `a//b` and hidden files are refused with IL6039 before any store sees them.
- Never use a file name sent by the client as the key. Build keys from ids you control, and keep the key in a `t.string()` field of a model.
- Keys are the same for every user and tenant. In a [multi-tenant app](database.md#multi-tenancy), put the tenant in the key (`` `tenants/${user.tenantId}/...` ``) and check access in the route before reading a file.

## Serving files

Return a `Response` with the file. Send it as an attachment unless you know the type is safe to show, because an HTML or SVG file shown inline runs in your site's origin:

```ts
import { notFound, route, t } from "@browserlessapi/inferlo";

export const downloadReport = route.get("/reports/:id", { params: t.object({ id: t.uuid() }) }).handle(async ({ params, storage, db, user }) => {
  const report = await db.reports.findOne({ where: { id: params.id, ownerId: user.id } });
  if (!report) throw notFound("Report not found.");
  const file = await storage.get(report.fileKey);
  if (!file) throw notFound("Report file not found.");
  return new Response(file, {
    headers: { "content-type": file.type, "content-disposition": `attachment; filename="${report.id}.pdf"` },
  });
});
```

## How diskStorage writes

Each `put` writes to a temporary file in `dir/.inferlo-tmp/` and renames it into `dir/<key>`, so readers see the old file or the new one, never half of one, and concurrent writes to one key leave one whole file. The media type is kept in `dir/.inferlo-meta/<key>`; files copied into the directory by hand are read as `application/octet-stream`. Keys cannot reach either directory.

For several instances, mount the same volume at `dir` on each, or use an object store.

## Testing

Use `memoryStorage()` and read files back through `app.storage`:

```ts
const app = createApp({ routes, storage: memoryStorage() });
const form = new FormData();
form.append("avatar", new Blob([png], { type: "image/png" }), "me.png");
await app.request("/me/avatar", { method: "POST", body: form, as: user });
assert.equal((await app.storage.get(`avatars/${user.id}`))?.type, "image/png");
```
