import { githubOAuth } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";
import { session } from "./session.ts";

// Sign in with GitHub: GET /auth/github/login sends the browser to GitHub, GET /auth/github/callback ends in the cookie session.
export const github = githubOAuth({
  clientId: settings.GITHUB_CLIENT_ID,
  clientSecret: settings.GITHUB_CLIENT_SECRET,
  session,
  async userId(profile, { db }) {
    if (!profile.email) return null;
    return (await db.users.findOne({ email: profile.email }))?.id ?? null;
  },
});
