import { createToken, hashToken } from "@browserlessapi/inferlo";
import { app } from "./app.ts";
import { settings } from "./config.ts";
import { shutdown } from "./shutdown.ts";

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
app.jobs.start();

// Graceful shutdown: /ready answers 503 at once so the load balancer stops sending traffic, requests are
// still served for 5 seconds, then in-flight requests and the running job finish and the server and the
// database close.
process.on("SIGTERM", () => void shutdown());
