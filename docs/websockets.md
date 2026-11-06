# WebSockets

`route.ws(path, options).handle(fn)` defines a WebSocket route. It is a route like any other: private unless `auth: "public"`, with roles, `permission`, `params`, `query` and `rateLimit`, registered in `createApp({ routes })`. Each message is JSON, validated against the `message` schema, and handled one at a time in the order it arrives.

```ts
// src/routes/chat.ts
import { route, t } from "@browserlessapi/inferlo";

export const chat = route
  .ws("/rooms/:room/chat", {
    params: t.object({ room: t.string().max(40) }),
    message: t.object({ text: t.string().min(1).max(2000) }),
    rateLimit: { max: 60, per: "minute", by: "user" },
    summary: "Chat in a room",
  })
  .handle(async ({ message, params, user, db }) => {
    const saved = await db.messages.insert({ room: params.room, text: message.text, authorId: user.id });
    return { id: saved.id, text: saved.text };   // sent back to this client as JSON
  });
```

In the browser:

```ts
const socket = new WebSocket("wss://api.example.com/rooms/lobby/chat");
socket.onmessage = (event) => console.log(JSON.parse(event.data));
socket.onopen = () => socket.send(JSON.stringify({ text: "Hello" }));
```

## Streaming AI answers

`socket.stream(ai.stream(...))` sends a model's answer to the client as it is generated, and resolves with the full text and usage once it is done, so the handler can save it:

```ts
export const assistant = route
  .ws("/assistant", { message: t.object({ question: t.string().min(1).max(2000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ message, ai, socket, user, db }) => {
    const { text } = await socket.stream(ai.stream({ model: "fast", prompt: message.question, for: user.id }));
    await db.answers.insert({ userId: user.id, question: message.question, text });
  });
```

The client receives `{ "type": "text", "text": "..." }` for each chunk, then `{ "type": "done", "usage": { ... } }`. When the model call fails, the error message (`{ "error": { "code": "IL5006", ... } }`) follows the chunks already sent. Streams from `ctx.ai` are cancelled when the socket closes (`ctx.signal`), so a client that leaves stops the model call and its cost. `socket.stream` takes only the result of `ai.stream(...)` (IL2013 otherwise).

## Rooms and broadcast

`socket.join(room)` adds a socket to a room, and `sockets.broadcast(room, data)` sends `data` as JSON to every socket in it. `ctx.sockets` is in HTTP routes, WebSocket handlers and jobs, and `app.sockets` everywhere else, so a route that saves a change can tell everyone watching:

```ts
// src/routes/projects.ts
export const watch = route
  .ws("/projects/:id/live", { params: t.object({ id: t.uuid() }), message: t.object({ text: t.string().min(1).max(2000) }) })
  .handle(async ({ message, params, socket, sockets, user, db }) => {
    await db.projects.get(params.id); // 404 for a project the user cannot see (ctx.db is tenant-scoped)
    socket.join(`project:${params.id}`);
    await sockets.broadcast(`project:${params.id}`, { type: "comment", from: user.id, text: message.text });
  });

export const update = route
  .patch("/projects/:id", { params: t.object({ id: t.uuid() }), body: t.object({ name: t.string().max(80) }) })
  .handle(async ({ params, body, db, sockets }) => {
    const project = await db.projects.update(params.id, body);
    await sockets.broadcast(`project:${params.id}`, { type: "project.updated", project });
    return project;
  });
```

- **Rooms are names you choose.** Name them after what they are about, with its id (`project:${id}`), and check that the user may see it before `socket.join`. A room name is a string of 1 to 200 characters (IL2014 otherwise). A socket can join any number of rooms; `socket.leave(room)` leaves one, and a closed socket leaves them all.
- **Rooms follow the tenant**, like `ctx.db`: a socket opened by a user with a tenant joins that tenant's room, and `ctx.sockets.broadcast` in a request or job with a tenant reaches only that tenant's sockets. `app.sockets.broadcast(room, data, { tenantId })` names the tenant (no tenant by default), and `{ tenantId }` works in `ctx.sockets` too.
- **The sender is included.** A handler that broadcasts to a room its own socket joined gets the message too, so every client renders from the same messages.
- **This process only.** Broadcasts reach the sockets open in the process that sends them: one server, or a job run by `app.jobs.start()` in that server. Across instances, and from `inferlo worker`, they arrive with the Redis transport (next release). `app.sockets.count()` and `app.sockets.count(room, { tenantId })` count the open sockets of this process.
- `broadcast` needs data that can be sent as JSON (IL2014 for `undefined`) and resolves once the message is sent.

## Connecting

The request that opens the socket goes through the same steps as an HTTP request, before the upgrade: middleware, `auth.resolve`, the route's `auth` and `permission`, `rateLimit`, and the `params` and `query` schemas. A client that fails one of them gets the HTTP error answer (401, 403, 422, 429) and no socket.

- **Auth.** Browsers cannot set an `Authorization` header on a WebSocket, but they send cookies, so [cookie sessions](auth.md) work as they do for HTTP routes. Servers and command-line clients can send a bearer token: `new WebSocket(url, { headers: { authorization: "Bearer ..." } })` on Node.js, Bun and Deno.
- **Origin.** Because browsers send cookies with a WebSocket from any page, a socket may only be opened from the app's own origin (the `Origin` host equals the `Host` header) or from an origin listed in `createApp({ cors: { origin: [...] } })` (`origin: "*"` allows every origin). Other origins get 403 IL3006. Clients that send no `Origin` header (servers, CLIs) may connect.
- A plain HTTP request to a WebSocket route gets 426 IL2010 with `Upgrade: websocket`, and a broken handshake 400 IL2010.
- `ctx.user` is the user who opened the socket, for every message. Close sockets yourself when a session ends early (`ctx.socket.close(4001, "signed out")`).

## Handling messages

The handler runs once per message with:

| | |
|---|---|
| `message` | The message, parsed from JSON and validated against `message` (any JSON value without a schema) |
| `params`, `query` | From the URL that opened the socket |
| `user` | The signed-in user (null only on public routes) |
| `socket` | `socket.send(data)` sends JSON to this client, `socket.stream(ai.stream(...))` streams a model's answer, `socket.join(room)` and `socket.leave(room)` join and leave rooms, `socket.close(code?, reason?)` closes it, `socket.id` is a random id |
| `sockets` | `sockets.broadcast(room, data)` sends to the sockets in a room (see [Rooms and broadcast](#rooms-and-broadcast)) |
| `db`, `ai`, `jobs`, `events`, `cache`, `audit` | As in HTTP routes; `db` is scoped to the user's tenant, `audit` entries record the user and `WS <path>` |
| `signal` | Aborted when the socket closes; `ctx.ai` calls use it |
| `requestId`, `url`, `headers` | Of the request that opened the socket |

- **Replies.** Return a value to send it back as JSON; return nothing to send nothing. Call `socket.send(data)` to send several messages from one handler (`socket.send` does nothing after the socket closed).
- **Order.** Messages of one socket are handled one at a time, in order. Different sockets run in parallel.
- **Errors.** A message that is not JSON gets `{ "error": { "code": "IL2003", ... } }`, one that does not match the schema `{ "error": { "code": "IL1001", ... } }` with the details, and one over the rate limit `IL2005`. An error thrown in the handler is sent the same way as an HTTP error body: `InferloError`s with their code and message, anything else as IL9000 "Internal server error" with the details logged. The socket stays open after errors.
- **Closing.** `socket.close()` closes with 1000; application codes are 3000 to 4999 (`socket.close(4000, "room closed")`); other codes raise IL2012. Binary messages close the socket with 1003, and a message larger than `createApp({ maxBodySize })` (default 1 MiB; at most 16 MiB on Node.js) with 1009.
- **Rate limits.** `rateLimit` counts opening the socket and every message, per user, tenant or IP, in the same counter: `{ max: 60, per: "minute" }` allows 60 connections and messages a minute.

## Servers

WebSocket routes work with the servers that can upgrade a request:

- **Node.js and Bun:** `app.listen(port)` and `serve(app, { port })`. Inferlo speaks the WebSocket protocol (RFC 6455) itself on Node.js, without a dependency, and uses Bun's own WebSocket server on Bun.
- **Deno:** `Deno.serve(app.fetch)`, `deno serve` and Deno Deploy (`export default app`), with `Deno.upgradeWebSocket`.

- **A Node.js server another framework created** (Express, Fastify, NestJS, Koa, `node:http`): `server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/api" }))` next to `toNodeHandler` (see [toNodeUpgradeHandler](integrations.md#websocket-routes-tonodeupgradehandler)). On Bun this needs Bun 1.4 or later (IL5031 on Bun 1.3, whose `node:http` cannot write to upgraded sockets).
- **Your own `Bun.serve`:** `Bun.serve({ routes, fetch: app.fetch, websocket: bunWebSocket })`, with `bunWebSocket` from `@browserlessapi/inferlo`. For a request Bun upgraded, `app.fetch` resolves to `undefined`, as `Bun.serve` expects.

Elsewhere (`app.request()` in tests, serverless functions, a `Bun.serve` without `bunWebSocket`) an upgrade request gets 501 IL2011. Test sockets against a real server: `const server = await app.listen(0)`, then `new WebSocket(\`ws://127.0.0.1:${server.port}/chat\`)`.

## Shutdown

`app.close()` stops new connections (503 IL2006), closes every open socket with 1001 "Server shutting down" so clients reconnect to another instance, and waits for messages that are being handled (up to its `timeoutMs`); their `ctx.signal` is aborted. Clients should reconnect with a backoff after a 1001 or 1006 close.

## describe and OpenAPI

`inferlo describe` lists WebSocket routes as `WS /path`; `describe()` has them with `method: "GET"`, `websocket: true` and the `message` schema. OpenAPI 3.1 cannot describe WebSockets, so they are not in `/openapi.json`, and they cannot be MCP tools.
