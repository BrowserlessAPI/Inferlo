{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "inferlo": {
    "entry": "src/app.ts",
    "server": "src/server.ts"
  },
  "scripts": {
    "dev": "inferlo dev",
    "start": "node src/server.ts",
    "worker": "inferlo worker",
    "check": "inferlo check",
    "describe": "inferlo describe",
    "db:push": "inferlo db push",
    "db:migrate": "inferlo db migrate",
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.18"
  },
  "dependencies": {
    "@browserlessapi/inferlo": "{{inferloDependency}}",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/node": "^22.18.0",
    "typescript": "^5.9.3"
  }
}
