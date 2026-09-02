import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATE_SH = fileURLToPath(new URL("../docker/migrate.sh", import.meta.url));

// A stand-in for the prisma CLI: appends every invocation to STUB_LOG and
// exits per STUB_MODE, so the tests can assert exactly which subcommands the
// script ran — and, critically, which it did NOT run.
const STUB_SOURCE = `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
let line = args;
if (process.env.STUB_ECHO_URL) line += " url=" + process.env.DATABASE_URL;
appendFileSync(process.env.STUB_LOG, line + "\\n");
const mode = process.env.STUB_MODE;
if (args.includes("migrate resolve")) process.exit(0);
if (mode === "p3005") {
  const deploys = readFileSync(process.env.STUB_LOG, "utf8")
    .split("\\n")
    .filter((l) => l.includes("migrate deploy")).length;
  if (deploys <= 1) {
    console.error("Error: P3005\\n\\nThe database schema is not empty.");
    process.exit(1);
  }
  process.exit(0);
}
if (mode === "p3009") {
  console.error(
    "Error: P3009\\n\\nmigrate found failed migrations in the target database.",
  );
  process.exit(1);
}
process.exit(0);
`;

const run = (mode, extraEnv = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-sh-test-"));
  const stub = join(dir, "stub-prisma.mjs");
  const log = join(dir, "calls.log");
  writeFileSync(stub, STUB_SOURCE);
  writeFileSync(log, "");
  const result = spawnSync("sh", [MIGRATE_SH], {
    encoding: "utf8",
    // The shell of this env is deliberately minimal — only PATH leaks in, so
    // a developer's DATABASE_URL/DB_* exports can't skew the assertions.
    env: {
      PATH: process.env.PATH,
      PRISMA_CMD: `node ${stub}`,
      PRISMA_SCHEMA: join(dir, "schema.prisma"),
      STUB_LOG: log,
      STUB_MODE: mode,
      ...extraEnv,
    },
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};

const DB_URL = "postgresql://user:pw@localhost:5432/onecli";

test("success: one migrate deploy, no resolve", () => {
  const { result, calls } = run("success", { DATABASE_URL: DB_URL });
  assert.equal(result.status, 0);
  assert.equal(calls.filter((c) => c.includes("migrate deploy")).length, 1);
  assert.equal(calls.filter((c) => c.includes("migrate resolve")).length, 0);
  assert.match(result.stdout, /Database migrations applied/);
});

test("P3005 (no migration history): baselines 0_init then deploys again", () => {
  const { result, calls } = run("p3005", { DATABASE_URL: DB_URL });
  assert.equal(result.status, 0);
  assert.deepEqual(
    calls.map((c) => (c.includes("resolve") ? "resolve" : "deploy")),
    ["deploy", "resolve", "deploy"],
  );
  assert.match(calls[1], /migrate resolve --applied 0_init/);
});

test("P3009 (failed migration row): fails WITHOUT attempting resolve", () => {
  const { result, calls } = run("p3009", { DATABASE_URL: DB_URL });
  assert.notEqual(result.status, 0);
  // The mutation test for the P3005 gate: the ungated legacy fallback would
  // run `migrate resolve --applied 0_init` here and this assertion would fail.
  assert.equal(calls.filter((c) => c.includes("migrate resolve")).length, 0);
  assert.match(result.stderr, /not attempting automatic repair/);
  assert.match(result.stderr, /logs migrations/);
});

test("assembles DATABASE_URL from DB_* parts with a URL-encoded password", () => {
  const { result, calls } = run("success", {
    STUB_ECHO_URL: "1",
    DB_HOST: "db.internal",
    DB_PORT: "5433",
    DB_NAME: "onecli",
    DB_USERNAME: "app",
    DB_PASSWORD: "p@ss w:rd/#",
  });
  assert.equal(result.status, 0);
  assert.match(
    calls[0],
    /url=postgresql:\/\/app:p%40ss%20w%3Ard%2F%23@db\.internal:5433\/onecli$/,
  );
});

test("a preset DATABASE_URL wins over DB_* parts", () => {
  const { result, calls } = run("success", {
    STUB_ECHO_URL: "1",
    DATABASE_URL: DB_URL,
    DB_HOST: "ignored.internal",
    DB_USERNAME: "ignored",
    DB_PASSWORD: "ignored",
  });
  assert.equal(result.status, 0);
  assert.match(calls[0], new RegExp(`url=${DB_URL.replace(/[/@:]/g, "\\$&")}$`));
});
