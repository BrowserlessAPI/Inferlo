# {{name}}

Built with [Inferlo](https://github.com/BrowserlessAPI/Inferlo).

```bash
npm install
npm run dev          # starts on http://localhost:3000 and prints a dev API key
npm run check        # typecheck + tests
npx inferlo describe   # routes, models and auth at a glance
```

Set `DATABASE_URL` in `.env` to use PostgreSQL, then run `npx inferlo db push`.

Background jobs run in the server process. To run them in separate processes too, set `jobQueue: { store: "database" }` in `src/app.ts` (needs PostgreSQL) and start workers with `npm run worker`.

AI coding agents: read `AGENTS.md`.
