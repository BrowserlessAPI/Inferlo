import { createToken, env, hashToken } from "@kairojs/core";
import { app } from "./app.ts";

await app.db.$sync();

// In-memory database: create a demo user and print an API key so you can try the API.
if (app.db.$adapter.dialect === "memory") {
  const user = await app.db.users.insert({ email: "dev@example.com", name: "Developer", role: "admin" });
  const token = createToken("dev");
  await app.db.api_keys.insert({ userId: user.id, hash: await hashToken(token) });
  console.log(`Dev API key: ${token}`);
  console.log(`Try: curl -H "Authorization: Bearer ${token}" http://localhost:${env("PORT", { default: "3000" })}/notes`);
}

const server = await app.listen(env.int("PORT", { default: 3000 }));
console.log(`{{name}} running on http://localhost:${server.port}`);
