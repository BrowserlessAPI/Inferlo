# MCP, OpenAPI and describe

Kairo apps describe themselves to humans, tools and AI agents from the same route and model definitions.

## MCP server

Add `tool: true` to a route and it becomes a tool on the app's built-in MCP server at `/mcp` (Streamable HTTP transport):

```ts
export const createTicket = route
  .post("/tickets", { body: Ticket.pick("title", "body"), summary: "Open a support ticket", tool: true })
  .handle(...);
```

- The tool name is the export name (`createTicket`), or `tool: { name, description }`.
- The input schema merges path params, query and body.
- Tool calls go through the normal router with the caller's `Authorization` header, so auth, roles and validation are exactly the same as over HTTP.

Connect from an MCP client, e.g. Claude Code:

```bash
claude mcp add --transport http my-app https://api.example.com/mcp --header "Authorization: Bearer <key>"
```

Set `createApp({ mcp: false })` to disable it, or `mcp: "/custom-path"` to move it.

## OpenAPI

`GET /openapi.json` returns an OpenAPI 3.1 document with every route, schema, auth requirement and error format. Write it to a file with `kairo openapi --out openapi.json`, or disable with `createApp({ openapi: false })`.

## describe

`app.describe()` (or `kairo describe --json`) returns a map of the whole app: models with every field, type, default, reference and database column; routes with method, path, auth, tool name and JSON schemas; AI aliases; and endpoints. AI coding agents read this instead of searching through files.
