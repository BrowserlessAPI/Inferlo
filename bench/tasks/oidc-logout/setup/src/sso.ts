import { oidc } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";
import { session } from "./session.ts";

// Single sign-on: GET /auth/login sends the browser to the provider, GET /auth/callback ends in the cookie session.
export const sso = oidc({
  issuer: settings.OIDC_ISSUER,
  clientId: settings.OIDC_CLIENT_ID,
  clientSecret: settings.OIDC_CLIENT_SECRET,
  session,
  async userId(claims, { db }) {
    if (!claims.email_verified || !claims.email) return null;
    return (await db.users.findOne({ email: claims.email }))?.id ?? null;
  },
});
