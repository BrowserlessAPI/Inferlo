import { createToken, hashToken } from "@browserlessapi/inferlo";
import { app } from "./app.ts";
import { settings } from "./config.ts";

await app.db.$sync();

// In-memory database: create a demo user and print an API key so you can try the API.
if (app.db.$adapter.dialect === "memory") {
  const user = await app.db.users.insert({ email: "dev@example.com", name: "Developer", role: "admin" });
  const token = createToken("dev");
  await app.db.api_keys.insert({ userId: user.id, hash: await hashToken(token) });
  console.log(`Dev API key: ${token}`);
  console.log(`Try: curl -H "Authorization: Bearer ${token}" http://localhost:${settings.PORT}/notes`);
}

const server = await app.listen(settings.PORT);
console.log(`{{name}} running on http://localhost:${server.port}`);

// Background jobs run in this process. With jobQueue: { store: "database" } in src/app.ts they can
// also run in separate processes: npm run worker.
const jobs = app.jobs.start();

process.on("SIGTERM", async () => {
  await jobs.stop(); // waits for the running job
  await server.close();
  await app.db.$close();
});
