// install.sh's networking provisioning, driven through its hidden hooks
// (--provision-url-env writes to $HOME/.onecli/.env with no Docker;
// --print-resolved prints the addresses the stack would advertise). Each
// case runs against a scratch HOME, so nothing touches a real install.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = new URL("./install.sh", import.meta.url).pathname;

const run = (args, env = {}) => {
  const home = mkdtempSync(join(tmpdir(), "onecli-install-test-"));
  const result = { home, envPath: join(home, ".onecli", ".env") };
  try {
    result.stdout = execFileSync("sh", [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: "utf8",
    });
    result.status = 0;
  } catch (err) {
    result.status = err.status;
    result.stdout = err.stdout ?? "";
    result.stderr = err.stderr ?? "";
  }
  return result;
};

const readEnv = (r) => readFileSync(r.envPath, "utf8");

test("provision persists the detected bind host (the revert trap is dead)", () => {
  const r = run(["--provision-url-env"], { ONECLI_BIND_HOST: "172.17.0.1" });
  assert.equal(r.status, 0);
  assert.match(readEnv(r), /^ONECLI_BIND_HOST=172\.17\.0\.1$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("a non-loopback bind freezes ONECLI_EXTERNAL_URL with the frozen comment", () => {
  const r = run(["--provision-url-env"], { ONECLI_BIND_HOST: "10.0.0.5" });
  assert.equal(r.status, 0);
  const env = readEnv(r);
  assert.match(env, /^# Frozen at install/m);
  assert.match(env, /^ONECLI_EXTERNAL_URL=http:\/\/10\.0\.0\.5:10254$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("the frozen URL honors a custom app port", () => {
  const r = run(["--provision-url-env"], {
    ONECLI_BIND_HOST: "10.0.0.5",
    ONECLI_APP_PORT: "24812",
  });
  assert.match(readEnv(r), /^ONECLI_EXTERNAL_URL=http:\/\/10\.0\.0\.5:24812$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("a loopback bind writes only the commented hint, never a pinned value", () => {
  const r = run(["--provision-url-env"], { ONECLI_BIND_HOST: "127.0.0.1" });
  const env = readEnv(r);
  assert.match(env, /^# ONECLI_EXTERNAL_URL=http:\/\/localhost:10254$/m);
  assert.doesNotMatch(env, /^ONECLI_EXTERNAL_URL=/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("an exported ONECLI_EXTERNAL_URL is validated and persisted, slashes stripped", () => {
  const r = run(["--provision-url-env"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "https://onecli.example.com//",
  });
  assert.equal(r.status, 0);
  assert.match(
    readEnv(r),
    /^ONECLI_EXTERNAL_URL=https:\/\/onecli\.example\.com$/m,
  );
  rmSync(r.home, { recursive: true, force: true });
});

test("validation refuses a scheme-less URL, naming the fix", () => {
  const r = run(["--provision-url-env"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "onecli.example.com",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /http:\/\/ or https:\/\//);
  rmSync(r.home, { recursive: true, force: true });
});

test("validation refuses a wildcard bind address as the URL", () => {
  const r = run(["--provision-url-env"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "http://0.0.0.0:10254",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bind address/);
  rmSync(r.home, { recursive: true, force: true });
});

test("validation refuses a URL with a path", () => {
  const r = run(["--provision-url-env"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "https://onecli.example.com/sub",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /path or query/);
  rmSync(r.home, { recursive: true, force: true });
});

test("keep-existing on re-run: neither the URL nor the bind is rewritten", () => {
  const r = run(["--provision-url-env"], { ONECLI_BIND_HOST: "10.0.0.5" });
  const first = readEnv(r);
  // Second run with a different exported bind: the persisted decision wins.
  execFileSync("sh", [SCRIPT, "--provision-url-env"], {
    env: { PATH: process.env.PATH, HOME: r.home },
    encoding: "utf8",
  });
  assert.equal(readEnv(r), first);
  rmSync(r.home, { recursive: true, force: true });
});

test("an existing APP_URL alias suppresses the freeze (operator already chose)", () => {
  const home = mkdtempSync(join(tmpdir(), "onecli-install-test-"));
  mkdirSync(join(home, ".onecli"), { recursive: true });
  writeFileSync(
    join(home, ".onecli", ".env"),
    "APP_URL=https://kept.example\n",
  );
  execFileSync("sh", [SCRIPT, "--provision-url-env"], {
    env: { PATH: process.env.PATH, HOME: home, ONECLI_BIND_HOST: "10.0.0.5" },
    encoding: "utf8",
  });
  const env = readFileSync(join(home, ".onecli", ".env"), "utf8");
  assert.doesNotMatch(env, /^ONECLI_EXTERNAL_URL=/m);
  rmSync(home, { recursive: true, force: true });
});

test("--print-resolved derives ports-mode addresses from the canonical URL", () => {
  const r = run(["--print-resolved"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "http://192.0.2.10:24812",
    ONECLI_API_PORT: "24813",
    ONECLI_GATEWAY_PORT: "24814",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^external=http:\/\/192\.0\.2\.10:24812$/m);
  assert.match(r.stdout, /^api=http:\/\/192\.0\.2\.10:24813$/m);
  assert.match(r.stdout, /^gateway=http:\/\/192\.0\.2\.10:24814$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("--print-resolved: https means proxy mode with the /gw suffix", () => {
  const r = run(["--print-resolved"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    ONECLI_EXTERNAL_URL: "https://onecli.example.com",
  });
  assert.match(r.stdout, /^api=https:\/\/onecli\.example\.com$/m);
  assert.match(r.stdout, /^gateway=https:\/\/onecli\.example\.com\/gw$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("--print-resolved: a bare APP_URL alias never derives the other origins", () => {
  const r = run(["--print-resolved"], {
    ONECLI_BIND_HOST: "127.0.0.1",
    APP_URL: "https://dashboard.example.com",
  });
  assert.match(r.stdout, /^external=https:\/\/dashboard\.example\.com$/m);
  assert.match(r.stdout, /^api=http:\/\/localhost:10256$/m);
  rmSync(r.home, { recursive: true, force: true });
});

test("the success output never prints the retired ONECLI_URL label", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.ok(
    !/ONECLI_URL:/.test(script),
    "install.sh must not echo ONECLI_URL:",
  );
});

test("wildcard and loopback-family binds never freeze a canonical URL", () => {
  // The same never-seeds rule as the resolver/wizard/gateway mirrors: a
  // frozen http://0.0.0.0 line would fail the resolver's boot validation
  // and crash-loop the stack with the bad line persisted.
  for (const bind of ["0.0.0.0", "::", "localhost", "::1"]) {
    const r = run(["--provision-url-env"], { ONECLI_BIND_HOST: bind });
    const env = readEnv(r);
    assert.doesNotMatch(
      env,
      /^ONECLI_EXTERNAL_URL=/m,
      `bind ${bind} must not freeze`,
    );
    assert.match(env, /^# ONECLI_EXTERNAL_URL=http:\/\/localhost:10254$/m);
    rmSync(r.home, { recursive: true, force: true });
  }
});

test("--print-resolved never displays a wildcard bind as the address", () => {
  const r = run(["--print-resolved"], { ONECLI_BIND_HOST: "0.0.0.0" });
  assert.match(r.stdout, /^external=http:\/\/localhost:10254$/m);
  rmSync(r.home, { recursive: true, force: true });
});
