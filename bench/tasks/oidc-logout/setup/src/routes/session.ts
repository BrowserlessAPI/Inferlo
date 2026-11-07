import { route, t, verifyPassword } from "@browserlessapi/inferlo";
import { session } from "../session.ts";

export const login = route
  .post("/login", { auth: "public", body: t.object({ email: t.string(), password: t.string() }), rateLimit: { max: 10, per: "minute", by: "ip" } })
  .handle(async (ctx) => {
    const user = await ctx.db.users.findOne({ email: ctx.body.email });
    if (!user?.passwordHash || !(await verifyPassword(ctx.body.password, user.passwordHash))) {
      return Response.json({ error: { code: "INVALID_LOGIN", message: "Wrong email or password." } }, { status: 401 });
    }
    return session.signIn(ctx, user.id);
  });

export const logout = route.post("/logout").handle((ctx) => {
  session.signOut(ctx);
  ctx.status(204);
  return undefined;
});
