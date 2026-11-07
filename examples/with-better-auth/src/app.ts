// Better Auth as the sign-in system of an Inferlo app, on one Postgres database:
// 1. One pg pool, shared by Better Auth (database: pool) and Inferlo (postgres({ pool })).
// 2. Better Auth's endpoints (sign-up, sign-in, sign-out, sessions) are served by session.middleware under
//    /api/auth; Inferlo routes get the signed-in user from Better Auth's session cookie.
// 3. Inferlo models keep Better Auth's user id as a plain field (ownerId), and the admin plugin's roles
//    work with auth: "admin". Requests that change data with the cookie from another site are refused (IL3007).
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import pg from "pg";
import { betterAuthSession } from "../../../src/better-auth.ts";
import { createApp, forbidden, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";

export const Project = model("projects", {
  ownerId: t.string().index(),
  name: t.string().min(1).max(200),
});

export interface Options {
  databaseUrl: string;
  /** At least 32 random characters, from config({ secrets }) in a real app. */
  secret: string;
  /** Where the app is served, such as https://app.example.com. */
  baseURL: string;
  logger?: { info(message: string): void; error(message: string): void };
}

export function makeApp({ databaseUrl, secret, baseURL, logger }: Options) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  const auth = betterAuth({
    database: pool,
    secret,
    baseURL,
    emailAndPassword: { enabled: true },
    plugins: [admin()],
    telemetry: { enabled: false },
  });

  const session = betterAuthSession(auth, {
    user: ({ user }) => ({ id: user.id, email: user.email, name: user.name, roles: user.role ? user.role.split(",") : [] }),
  });

  const createProject = route
    .post("/projects", { body: t.object({ name: t.string().min(1).max(200) }) })
    .handle(({ body, user, db, status }) => {
      status(201);
      return db.projects.insert({ ownerId: user.id, name: body.name });
    });

  const myProjects = route.get("/projects").handle(({ user, db }) => db.projects.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: "asc" } }));

  // Better Auth's user table, read in the same database: the owner's name next to the project.
  const getProject = route
    .get("/projects/:id", { params: t.object({ id: t.uuid() }) })
    .handle(async ({ params, user, db }) => {
      const project = await db.projects.find(params.id);
      if (!project) throw notFound(`No project ${params.id}.`);
      if (project.ownerId !== user.id && !(user.roles ?? []).includes("admin")) throw forbidden("This project belongs to another user.");
      const [owner] = await db.$sql(`select name, email from "user" where id = $1`, [project.ownerId]);
      return { ...project, owner: owner ?? null };
    });

  const allProjects = route.get("/admin/projects", { auth: "admin" }).handle(({ db }) => db.projects.findMany({ orderBy: { createdAt: "asc" } }));

  const app = createApp({
    name: "with-better-auth",
    models: [Project],
    db: postgres({ pool }),
    routes: [{ createProject, myProjects, getProject, allProjects }],
    auth: session,
    middleware: [session.middleware],
    logger,
  });
  return { app, auth, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof Project];
    user: { id: string; email: string; name: string; roles: string[] };
  }
}
