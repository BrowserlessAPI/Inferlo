import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

// Better Auth keeps its own users and sessions (in memory here; a pg pool in production).
export const auth = betterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  secret: process.env.BETTER_AUTH_SECRET ?? "development-only-better-auth-secret-0123456789",
  baseURL: "https://app.example.com",
  emailAndPassword: { enabled: true },
  telemetry: { enabled: false },
  logger: { disabled: true },
});
