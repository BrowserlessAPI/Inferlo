import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import { betterAuthSession } from "./src/better-auth.ts";
import { createApp, route } from "./src/index.ts";
const BASE = "http://app.test";
function mk() { return betterAuth({ database: memoryAdapter({ user: [], session: [], account: [], verification: [] }), secret: "better-auth-test-secret-0123456789abcdef0123456789", baseURL: BASE, emailAndPassword: { enabled: true }, telemetry: { enabled: false }, logger: { disabled: true }, plugins: [bearer(), admin()] }); }
const me = route.get("/me").handle(({ user }) => user);
const first = mk(); const s1 = betterAuthSession(first);
const app1 = createApp({ routes: [{ me }], auth: s1, middleware: [s1.middleware], logger: { info() {}, error() {} } });
async function run(app: any, auth: any, i: number) {
  const res = await app.fetch(new Request(BASE + "/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `x${i}@e.com`, password: "correct horse battery", name: "A" }) }));
  const cookie = res.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ");
  const r = await app.fetch(new Request(BASE + "/me", { headers: { cookie } }));
  const direct = await auth.api.getSession({ headers: new Headers({ cookie }) });
  console.log(i, res.status, r.status, "direct", Boolean(direct));
}
await run(app1, first, 1);
await run(app1, first, 2);
const second = mk(); const s2 = betterAuthSession(second, { user: ({ user }) => ({ id: user.id }) });
const app2 = createApp({ routes: [{ me }], auth: s2, middleware: [s2.middleware], logger: { info() {}, error() {} } });
await run(app2, second, 3);
