# {{name}}

Built with [Kairo](https://github.com/BrowserlessAPI/kairo).

```bash
npm install
npm run dev          # starts on http://localhost:3000 and prints a dev API key
npm run check        # typecheck + tests
npx kairo describe   # routes, models and auth at a glance
```

Set `DATABASE_URL` in `.env` to use PostgreSQL, then run `npx kairo db push`.

AI coding agents: read `AGENTS.md`.
