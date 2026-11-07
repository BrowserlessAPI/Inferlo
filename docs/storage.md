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
| `s3Storage({ bucket, region, accessKeyId, secretAccessKey })` | An S3-compatible object store shared by every instance: AWS S3, Cloudflare R2, MinIO and others. Needs only `fetch` and Web Crypto. Gives [signed download URLs](#signed-download-urls). See [S3, R2 and MinIO](#s3-r2-and-minio). |
| Your own `StorageStore` | Any other store: an object with `name`, `put(key, bytes, type)`, `get(key)` (resolves to `{ bytes, type }` or `null`) and `delete(key)` (resolves to `true` when the key existed), and optionally `url(key, expiresIn)` for signed URLs. |

Without a `storage` option, `ctx.storage` throws IL6037 (a 500 in routes), so files are never kept somewhere you did not choose. An invalid option fails at startup with IL6038.

## The API

| Call | Result |
|---|---|
| `await storage.put(key, data, { type })` | Stores `data` (a `File` from `t.file()`, a `Blob`, a `Uint8Array`, an `ArrayBuffer` or a string) under `key`, replacing what was there. Resolves to `{ key, size, type }`. |
| `await storage.get(key)` | The file as a web `File` (`name` is the key's last segment, `type` the stored media type), or `null`. |
| `await storage.delete(key)` | Removes the file. Resolves to `true` when it existed, `false` otherwise. |
| `await storage.url(key, { expiresIn })` | A signed URL that downloads the file without credentials for `expiresIn` seconds (1 to 604800, seven days). Only stores that sign URLs have it (`s3Storage`); memory and disk stores throw IL6050. See [Signed download URLs](#signed-download-urls). |
| `storage.store` | The store's name (`"memory"`, `"disk"`, `"s3"` or your store's `name`), or `null` without a storage option. `inferlo describe` shows it as `storage`. |

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

## S3, R2 and MinIO

`s3Storage()` keeps files in a bucket of any store that speaks the S3 API. Requests are signed with AWS Signature Version 4 on Web Crypto and sent with `fetch`, so there is no AWS SDK and no runtime dependency.

```ts
import { createApp, env, s3Storage } from "@browserlessapi/inferlo";

export const app = createApp({
  routes,
  storage: s3Storage({
    bucket: env("S3_BUCKET"),
    region: env("S3_REGION"),
    accessKeyId: env("S3_ACCESS_KEY_ID"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
  }),
});
```

| Store | Options |
|---|---|
| AWS S3 | `bucket`, `region` (`"eu-central-1"`), the access key; leave `endpoint` out. The bucket is addressed by host name (`https://<bucket>.s3.<region>.amazonaws.com`). With temporary credentials (an IAM role, AWS STS), also pass `sessionToken`. |
| Cloudflare R2 | `endpoint: "https://<account id>.r2.cloudflarestorage.com"`, `region: "auto"`, and an R2 API token's access key id and secret. |
| MinIO and other S3-compatible stores | `endpoint` (`"https://minio.internal.example.com"`, or `"http://localhost:9000"` in development), the region the server is configured with (MinIO's default is `"us-east-1"`), and an access key. |

| Option | Meaning |
|---|---|
| `bucket` | The bucket name: 3 to 63 lowercase letters, digits, `.` and `-`. The bucket must exist; Inferlo does not create it. |
| `region` | The bucket's region, `"auto"` on R2. |
| `accessKeyId`, `secretAccessKey` | A key that may read, write and delete objects in the bucket (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`). Read them with `env()`; the secret is never logged, put in an error or in a URL. |
| `sessionToken` | Session token of temporary credentials. |
| `endpoint` | The store's origin for anything but AWS S3. https is required except on `localhost`. No path: the bucket goes in `bucket`. |
| `pathStyle` | `true` addresses the bucket in the path (`https://endpoint/bucket/key`). Default: `true` with an `endpoint`, `false` on AWS S3. Bucket names with dots need it on AWS S3. |
| `timeoutMs` | Time limit of each request to the store, 1000 to 300000 ms (default 30000). |

- Keys are object keys in the bucket as they are: `avatars/42.png` is `s3://<bucket>/avatars/42.png`. To share a bucket between apps, start the keys with the app's name.
- `storage.delete(key)` asks the store whether the key exists before deleting it, because S3 answers a delete the same either way.
- When the store refuses a request or cannot be reached, the call throws IL6049 (a 502 in routes) naming the operation, key, bucket and S3's error code (`AccessDenied`, `NoSuchBucket`, `SignatureDoesNotMatch`), never a credential. A missing key is `null`, but a missing bucket is IL6049.
- Invalid options (an http endpoint that is not localhost, an endpoint with a path, an unknown option) fail at startup with IL6048.
- Each file is sent and read in one request, which suits files up to a few hundred megabytes; keep the `t.file({ maxBytes })` limit of the route below that.

## Signed download URLs

`storage.url(key, { expiresIn })` returns a URL that downloads the file straight from the store, without credentials, for `expiresIn` seconds. Use it for large files, so they do not pass through your app: check access in the route, then redirect.

```ts
export const downloadReport = route.get("/reports/:id", { params: t.object({ id: t.uuid() }) }).handle(async ({ params, storage, db, user }) => {
  const report = await db.reports.findOne({ where: { id: params.id, ownerId: user.id } });
  if (!report) throw notFound("Report not found.");
  return Response.redirect(await storage.url(report.fileKey, { expiresIn: 300 }), 303);
});
```

- `expiresIn` is required, a whole number of seconds from 1 to 604800 (seven days, the S3 limit); anything else is IL6039. Keep it short: anyone who has the URL can download the file until it expires, and it cannot be revoked earlier except by deleting the file or the key that signed it.
- The URL allows `GET` of that one key only.
- The browser receives the file with the media type it was stored with. An HTML or SVG file opened from a signed URL runs in the store's origin, not yours, but still check what you let users upload.
- Stores without signed URLs (`memoryStorage()`, `diskStorage()`) throw IL6050: serve those files from a route as shown in [Serving files](#serving-files).

## How diskStorage writes

Each `put` writes to a temporary file in `dir/.inferlo-tmp/` and renames it into `dir/<key>`, so readers see the old file or the new one, never half of one, and concurrent writes to one key leave one whole file. The media type is kept in `dir/.inferlo-meta/<key>`; files copied into the directory by hand are read as `application/octet-stream`. Keys cannot reach either directory.

For several instances, mount the same volume at `dir` on each, or use [`s3Storage()`](#s3-r2-and-minio).

## Testing

Use `memoryStorage()` and read files back through `app.storage`:

```ts
const app = createApp({ routes, storage: memoryStorage() });
const form = new FormData();
form.append("avatar", new Blob([png], { type: "image/png" }), "me.png");
await app.request("/me/avatar", { method: "POST", body: form, as: user });
assert.equal((await app.storage.get(`avatars/${user.id}`))?.type, "image/png");
```
