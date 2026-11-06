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
| `socket` | `socket.send(data)` sends JSON to this client, `socket.close(code?, reason?)` closes it, `socket.id` is a random id |
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

Elsewhere (`toNodeHandler` inside another framework, `app.request()` in tests, serverless functions) an upgrade request gets 501 IL2011. Test sockets against a real server: `const server = await app.listen(0)`, then `new WebSocket(\`ws://127.0.0.1:${server.port}/chat\`)`.

## Shutdown

`app.close()` stops new connections (503 IL2006), closes every open socket with 1001 "Server shutting down" so clients reconnect to another instance, and waits for messages that are being handled (up to its `timeoutMs`); their `ctx.signal` is aborted. Clients should reconnect with a backoff after a 1001 or 1006 close.

## describe and OpenAPI

`inferlo describe` lists WebSocket routes as `WS /path`; `describe()` has them with `method: "GET"`, `websocket: true` and the `message` schema. OpenAPI 3.1 cannot describe WebSockets, so they are not in `/openapi.json`, and they cannot be MCP tools.
