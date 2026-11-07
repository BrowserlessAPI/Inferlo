import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

interface Person {
  id: string;
  email: string;
  displayName: string;
}

const people: Record<string, Person> = {
  ada: { id: "user-ada", email: "ada@example.com", displayName: "Ada" },
  bob: { id: "user-bob", email: "bob@example.com", displayName: "Bob" },
};

passport.use(new LocalStrategy((username, password, done) => done(null, password === "correct horse" ? (people[username] ?? false) : false)));
passport.serializeUser<string>((user, done) => done(null, (user as Person).id));
passport.deserializeUser<string>((id, done) => done(null, Object.values(people).find((p) => p.id === id) ?? false));

// The existing Express app: users sign in with Passport, and the Inferlo app serves the API under /api.
export const server = express();
server.use(session({ secret: process.env.SESSION_SECRET ?? "development-only-session-secret", resave: false, saveUninitialized: false }));
server.use(passport.session());
server.post("/login", express.urlencoded({ extended: false }), passport.authenticate("local"), (_req, res) => void res.json({ ok: true }));
server.use("/api", toNodeHandler(app));
