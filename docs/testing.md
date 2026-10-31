# Testing

Tests call the app in-process with `app.request`, so there is no server or port.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/kairo";
import { readJson } from "@browserlessapi/kairo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("creates a note", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const owner = await app.db.users.insert({ email: "a@example.com", name: "A" });
  const user = { id: owner.id, email: owner.email, name: owner.name, roles: [] };

  const res = await app.request("/notes", { method: "POST", json: { title: "Hi" }, as: user });
  const note = await readJson(res, 201);
  assert.equal(note.title, "Hi");
});
```

- `as: user` runs the request as that user and skips `auth.resolve`. It only works through `app.request`, never over HTTP.
- `readJson(res, status)` checks the status and includes the body in the failure message.
- `memory()` gives every test a fresh database.
- `mockProvider({ respond })` makes AI calls deterministic.
- `readEvents(res)` parses streaming (SSE) responses.

Run with `node --test` or `bun test`.
