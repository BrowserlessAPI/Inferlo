# Deployment

An Inferlo app is a standard `fetch(Request) => Response` handler, so it runs anywhere.

## Linux server (Node.js)

```bash
npm ci --omit=dev
DATABASE_URL=postgres://... npx inferlo db migrate --apply   # or inferlo db push if you do not use migrations
DATABASE_URL=postgres://... PORT=3000 node src/server.ts
```

Run it under systemd or pm2 behind Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # needed for AI streaming responses
}
```

Behind a proxy like this, set `createApp({ trustProxy: true })` so routes with `rateLimit: { by: "ip" }` see the client's address instead of the proxy's. With more than one instance, use `rateLimit: { store: "database" }` so the counts are shared, and `jobQueue: { store: "database" }` so background jobs are too (see [jobs](jobs.md)).

## Bun

```bash
bun src/server.ts
```

`app.listen()` uses `Bun.serve` automatically.

## Deno

```ts
Deno.serve(app.fetch);
```

## Cloudflare Workers and other edge runtimes

```ts
import { app } from "./app.ts";
export default app;   // app.fetch is the Worker handler
```

Use a Postgres driver that supports your edge runtime, or `memory()` for stateless services.
