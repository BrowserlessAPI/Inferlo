{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "kairo": {
    "entry": "src/app.ts",
    "server": "src/server.ts"
  },
  "scripts": {
    "dev": "kairo dev",
    "start": "node src/server.ts",
    "check": "kairo check",
    "describe": "kairo describe",
    "db:push": "kairo db push",
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.18"
  },
  "dependencies": {
    "kairojs": "{{kairoDependency}}",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/node": "^22.18.0",
    "typescript": "^5.9.3"
  }
}
