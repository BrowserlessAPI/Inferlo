import Credentials from "@auth/core/providers/credentials";

const people: Record<string, { id: string; name: string }> = {
  "ada@example.com": { id: "user-ada", name: "Ada" },
  "bob@example.com": { id: "user-bob", name: "Bob" },
};

// The Auth.js configuration the web frontend signs in with (JWT sessions).
export const authConfig = {
  secret: process.env.AUTH_SECRET ?? "development-only-auth-secret-0123456789abcdef",
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (input) => {
        const person = people[String(input.email)];
        return person && input.password === "correct horse" ? { id: person.id, email: String(input.email), name: person.name } : null;
      },
    }),
  ],
  callbacks: {
    // Inferlo needs the user id in the session.
    session: ({ session, token }: { session: { user: Record<string, unknown> }; token: { sub?: string } }) => ({ ...session, user: { ...session.user, id: token.sub } }),
  },
};
