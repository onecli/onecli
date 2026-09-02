import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvFile, resolveEnv } from "./env-file.mjs";
import {
  SECRET_SPECS,
  ensureSecrets,
  ensureDatabaseUrl,
  DEV_DATABASE_URL,
} from "./secrets.mjs";

const load = (content = "") => {
  const p = join(mkdtempSync(join(tmpdir(), "secrets-test-")), ".env");
  writeFileSync(p, content);
  return new EnvFile(p);
};

// The shell of these tests is empty on purpose — the real process.env would
// leak a developer's exports into the assertions.
const run = (env, shell = {}) =>
  ensureSecrets(env, resolveEnv(env, shell), shell);

test("an empty file gets every SECRET_SPECS secret, in valid shapes", () => {
  const env = load();
  const { generated, replaced } = run(env);
  assert.deepEqual(
    generated,
    SECRET_SPECS.map((s) => s.key),
  );
  assert.deepEqual(replaced, []);
  env.save();

  const again = new EnvFile(env.path);
  assert.match(again.get("RUNNER_TOKEN"), /^rnr_[0-9a-f]{64}$/);
  assert.match(again.get("CHANNEL_ADAPTER_TOKEN"), /^cha_[0-9a-f]{64}$/);
  for (const key of [
    "BETTER_AUTH_SECRET",
    "SECRET_ENCRYPTION_KEY",
    "GATEWAY_INTERNAL_SECRET",
  ])
    assert.equal(Buffer.from(again.get(key), "base64").length, 32);
});

test("valid existing values are never touched — the file is byte-identical", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const content = `BETTER_AUTH_SECRET=keep-me-exactly\nSECRET_ENCRYPTION_KEY=${key}\nGATEWAY_INTERNAL_SECRET=alive\nRUNNER_TOKEN=rnr_custom\nCHANNEL_ADAPTER_TOKEN=cha_custom\nSSH_TERMINATOR_SECRET=ssh-secret-kept\n`;
  const env = load(content);
  const { generated, replaced } = run(env);
  assert.deepEqual(generated, []);
  assert.deepEqual(replaced, []);
  assert.equal(env.save(), false);
  assert.equal(readFileSync(env.path, "utf8"), content);
});

test("a present-empty secret is filled in place", () => {
  const env = load("BETTER_AUTH_SECRET=\n");
  const { generated } = run(env);
  assert.ok(generated.includes("BETTER_AUTH_SECRET"));
  env.save();
  assert.match(
    readFileSync(env.path, "utf8"),
    /^BETTER_AUTH_SECRET=.+\n/,
  );
});

test("a whitespace-only quoted secret counts as empty and is regenerated", () => {
  const env = load('BETTER_AUTH_SECRET="   "\n');
  const { generated } = run(env);
  assert.ok(generated.includes("BETTER_AUTH_SECRET"));
  env.save();
  const value = new EnvFile(env.path).get("BETTER_AUTH_SECRET");
  assert.ok(value.trim().length > 0);
});

test("an invalid SECRET_ENCRYPTION_KEY in the FILE is replaced (it never encrypted anything)", () => {
  const env = load("SECRET_ENCRYPTION_KEY=change-me-to-secure-key\n");
  const { replaced } = run(env);
  assert.deepEqual(replaced, ["SECRET_ENCRYPTION_KEY"]);
  env.save();
  const value = new EnvFile(env.path).get("SECRET_ENCRYPTION_KEY");
  assert.equal(Buffer.from(value, "base64").length, 32);
});

test("a shell export suppresses minting, and an invalid shell value is only reported", () => {
  const env = load();
  const shell = {
    RUNNER_TOKEN: "rnr_from_shell",
    SECRET_ENCRYPTION_KEY: "too-short",
  };
  const { generated, replaced, shadowedInvalid } = run(env, shell);
  assert.ok(!generated.includes("RUNNER_TOKEN"));
  assert.deepEqual(replaced, []);
  assert.deepEqual(shadowedInvalid, ["SECRET_ENCRYPTION_KEY"]);
  env.save();
  const written = readFileSync(env.path, "utf8");
  assert.ok(!written.includes("RUNNER_TOKEN"));
  assert.ok(!written.includes("SECRET_ENCRYPTION_KEY"));
});

test("EDITION=cloud: an absent SECRET_ENCRYPTION_KEY stays absent (KMS mode), an invalid one is still replaced", () => {
  const absent = load("EDITION=cloud\n");
  run(absent);
  absent.save();
  assert.ok(!readFileSync(absent.path, "utf8").includes("SECRET_ENCRYPTION_KEY"));

  const invalid = load("EDITION=cloud\nSECRET_ENCRYPTION_KEY=bogus\n");
  const { replaced } = run(invalid);
  assert.deepEqual(replaced, ["SECRET_ENCRYPTION_KEY"]);
});

test("ensureDatabaseUrl writes the dev default only when truly unset", () => {
  const missing = load();
  ensureDatabaseUrl(missing, resolveEnv(missing, {}), {});
  assert.equal(missing.get("DATABASE_URL"), DEV_DATABASE_URL);

  const empty = load("DATABASE_URL=\n");
  ensureDatabaseUrl(empty, resolveEnv(empty, {}), {});
  assert.equal(empty.get("DATABASE_URL"), DEV_DATABASE_URL);

  const set = load("DATABASE_URL=postgresql://elsewhere/db\n");
  ensureDatabaseUrl(set, resolveEnv(set, {}), {});
  assert.equal(set.get("DATABASE_URL"), "postgresql://elsewhere/db");

  const shell = load();
  ensureDatabaseUrl(shell, resolveEnv(shell, { DATABASE_URL: "x" }), {
    DATABASE_URL: "x",
  });
  assert.equal(shell.has("DATABASE_URL"), false);
});
