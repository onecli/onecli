import assert from "node:assert/strict";
import test from "node:test";
import { EnvFile } from "./lib/env-file.mjs";
import { ensureSshEnv } from "./lib/ssh-env.mjs";

// NOTE: that the minted TERMINATOR_HOST_KEY actually parses with ssh2 (which
// rejects PKCS#8 ed25519 — the whole reason for the openssh-key-v1 encoder)
// is cross-checked in apps/ssh-terminator's vitest, where ssh2 is a dep and
// the real terminator handshake exercises it.

let counter = 0;
// A path that does not exist → EnvFile starts empty; we never save it.
const inMemoryEnv = () =>
  new EnvFile(`/tmp/ssh-env-test-${process.pid}-${(counter += 1)}.env`, {
    label: "test",
  });

test("provisions the full coupled set on a fresh env (with an explicit port)", () => {
  const env = inMemoryEnv();
  const minted = ensureSshEnv(env, {}, {
    hostname: "host.example",
    sshPort: "10257",
  });
  assert.deepEqual(
    [...minted].sort(),
    [
      "SSH_CA_PRIVATE_KEY",
      "SSH_HOST",
      "SSH_PORT",
      "TERMINATOR_CA_PUBLIC_KEY",
      "TERMINATOR_HOST_KEY",
    ].sort(),
  );
  assert.match(env.get("SSH_CA_PRIVATE_KEY"), /BEGIN PRIVATE KEY/);
  assert.match(env.get("TERMINATOR_HOST_KEY"), /BEGIN OPENSSH PRIVATE KEY/);
  assert.match(env.get("TERMINATOR_CA_PUBLIC_KEY"), /^ssh-ed25519 /);
  assert.equal(env.get("SSH_HOST"), "host.example");
  assert.equal(env.get("SSH_PORT"), "10257");
});

test("omits SSH_PORT when no port is given (the compose doors' single-knob law)", () => {
  const env = inMemoryEnv();
  const minted = ensureSshEnv(env, {}, { hostname: "host.example" });
  assert.ok(!minted.includes("SSH_PORT"));
  assert.equal(env.get("SSH_PORT"), undefined);
});

test("is idempotent — an existing value is never rewritten", () => {
  const env = inMemoryEnv();
  ensureSshEnv(env, {}, { hostname: "host.example" });
  const firstCa = env.get("SSH_CA_PRIVATE_KEY");
  const firstHost = env.get("SSH_HOST");
  // Second pass over the now-populated env mints nothing.
  const resolved = {
    SSH_CA_PRIVATE_KEY: firstCa,
    TERMINATOR_CA_PUBLIC_KEY: env.get("TERMINATOR_CA_PUBLIC_KEY"),
    TERMINATOR_HOST_KEY: env.get("TERMINATOR_HOST_KEY"),
    SSH_HOST: firstHost,
    SSH_PORT: env.get("SSH_PORT"),
  };
  const minted = ensureSshEnv(env, resolved, { hostname: "other.example" });
  assert.deepEqual(minted, []);
  assert.equal(env.get("SSH_CA_PRIVATE_KEY"), firstCa);
  assert.equal(env.get("SSH_HOST"), firstHost);
});

test("re-derives only the public line when just the private key exists", () => {
  const env = inMemoryEnv();
  // Seed a real CA private key, everything else absent.
  ensureSshEnv(env, {}, { hostname: "host.example" });
  const ca = env.get("SSH_CA_PRIVATE_KEY");
  const fresh = inMemoryEnv();
  const minted = ensureSshEnv(
    fresh,
    { SSH_CA_PRIVATE_KEY: ca },
    { hostname: "host.example" },
  );
  assert.ok(minted.includes("TERMINATOR_CA_PUBLIC_KEY"));
  assert.ok(!minted.includes("SSH_CA_PRIVATE_KEY"));
  // The derived line matches the one the first pass produced from the same key.
  assert.equal(
    fresh.get("TERMINATOR_CA_PUBLIC_KEY"),
    env.get("TERMINATOR_CA_PUBLIC_KEY"),
  );
});

test("no-ops entirely on the cloud edition (never shadows KMS)", () => {
  const env = inMemoryEnv();
  const minted = ensureSshEnv(env, { EDITION: "cloud" }, { hostname: "h" });
  assert.deepEqual(minted, []);
  assert.equal(env.get("SSH_CA_PRIVATE_KEY"), undefined);
});

test("a shell-set value shadows generation", () => {
  const env = inMemoryEnv();
  const minted = ensureSshEnv(
    env,
    { SSH_HOST: "operator-set.example" },
    { hostname: "derived.example" },
  );
  assert.ok(!minted.includes("SSH_HOST"));
});
