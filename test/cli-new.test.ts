// inferlo new: the project for PostgreSQL (default), and --db mysql and --db sqlite. The SQLite project is loaded
// (with its imports pointed at this repository) and its tables are created, so the edited files work together.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "inferlo-new-"));
const cli = (...args: string[]) => spawnSync("node", [path.join(repo, "src", "cli", "main.ts"), ...args, "--json"], { cwd: root, encoding: "utf8" });
const read = (dir: string, file: string) => readFileSync(path.join(root, dir, file), "utf8");

describe("inferlo new", () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  test("creates a PostgreSQL project by default", () => {
    const r = cli("new", "pg-app");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).database, "postgres");
    assert.match(read("pg-app", "src/app.ts"), /db: settings\.DATABASE_URL \? postgres\(\{ url: settings\.DATABASE_URL \}\) : memory\(\)/);
    assert.equal(JSON.parse(read("pg-app", "package.json")).dependencies.pg, "^8.16.0");
  });

  test("--db mysql uses mysql() and mysql2", () => {
    const r = cli("new", "my-app", "--db", "mysql");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).database, "mysql");
    const app = read("my-app", "src/app.ts");
    assert.match(app, /import \{ mysql \} from "@browserlessapi\/inferlo\/mysql";/);
    assert.match(app, /db: settings\.DATABASE_URL \? mysql\(\{ url: settings\.DATABASE_URL \}\) : memory\(\)/);
    assert.doesNotMatch(app, /postgres/);
    const deps = JSON.parse(read("my-app", "package.json")).dependencies;
    assert.equal(deps.mysql2, "^3.0.0");
    assert.equal(deps.pg, undefined);
    assert.match(read("my-app", ".env.example"), /mysql:\/\//);
    assert.match(read("my-app", "README.md"), /MySQL/);
  });

  test("--db sqlite keeps the data in data/app.db with no database package, and the app runs", async () => {
    const r = cli("new", "lite-app", "--db=sqlite");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.database, "sqlite");
    assert.ok(out.files.includes(path.join("lite-app", "data", ".gitkeep")));
    const app = read("lite-app", "src/app.ts");
    assert.match(app, /db: sqlite\(\{ path: settings\.SQLITE_PATH \}\)/);
    assert.doesNotMatch(app, /postgres|memory/);
    assert.match(read("lite-app", "src/config.ts"), /SQLITE_PATH: t\.string\(\)\.default\("data\/app\.db"\)/);
    assert.doesNotMatch(read("lite-app", "src/config.ts"), /DATABASE_URL/);
    assert.deepEqual(Object.keys(JSON.parse(read("lite-app", "package.json")).dependencies), ["@browserlessapi/inferlo"]);
    assert.match(read("lite-app", ".gitignore"), /^data\/\*\.db$/m);
    assert.match(read("lite-app", ".env.example"), /^SQLITE_PATH=data\/app\.db$/m);
    assert.ok(existsSync(path.join(root, "lite-app", "data", ".gitkeep")));

    // Load the project against this repository's source and create its tables in the default file.
    const dir = path.join(root, "lite-app");
    for (const file of ["src/app.ts", "src/config.ts", "src/models.ts", "src/routes/notes.ts"]) {
      const full = path.join(dir, file);
      const text = readFileSync(full, "utf8")
        .replaceAll('"@browserlessapi/inferlo/sqlite"', JSON.stringify(path.join(repo, "src", "db", "sqlite.ts")))
        .replaceAll('"@browserlessapi/inferlo"', JSON.stringify(path.join(repo, "src", "index.ts")));
      writeFileSync(full, text);
    }
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { app } = await import(pathToFileURL(path.join(dir, "src", "app.ts")).href);
      assert.equal(app.describe().database, "sqlite");
      assert.ok((await app.db.$sync()).length > 0);
      const user = await app.db.users.insert({ email: "a@example.com", name: "A" });
      assert.equal((await app.db.users.find(user.id)).email, "a@example.com");
      await app.db.$close();
      assert.ok(existsSync(path.join(dir, "data", "app.db")));
    } finally {
      process.chdir(previous);
    }
  });

  test("an unknown --db is IL8010", () => {
    const r = cli("new", "bad-app", "--db", "oracle");
    assert.notEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "IL8010");
    assert.match(out.error.fix, /--db sqlite/);
    assert.equal(existsSync(path.join(root, "bad-app")), false, "nothing is created");
  });
});
