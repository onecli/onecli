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

// ─────────────────────────────────────────────────────────────────────────
// The upgrade path: pulling the agent sandbox image, and restarting this
// installation's sandboxes onto it.
//
// A stand-in for the docker CLI, in the style of scripts/migrate-sh.test.mjs:
// it appends every invocation to STUB_LOG and answers `ps` from STUB_IDS, so
// the tests can assert exactly which calls the script makes and, critically,
// which it never makes.
// ─────────────────────────────────────────────────────────────────────────

const DOCKER_STUB = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, args.join(" ") + "\\n");
if (args[0] === "ps") process.stdout.write(process.env.STUB_IDS ?? "");
process.exit(0);
`;

/** Run a hook with a stubbed docker; returns the result plus its call log. */
const runStubbed = (args, { env = {}, envFile = "", ids = "" } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "onecli-install-test-"));
  mkdirSync(join(home, ".onecli"), { recursive: true });
  if (envFile) writeFileSync(join(home, ".onecli", ".env"), envFile);
  const stub = join(home, "stub-docker.mjs");
  const log = join(home, "docker-calls.log");
  writeFileSync(stub, DOCKER_STUB);
  writeFileSync(log, "");
  const result = { home };
  try {
    result.stdout = execFileSync("sh", [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ONECLI_DOCKER_CMD: `node ${stub}`,
        STUB_LOG: log,
        STUB_IDS: ids,
        ...env,
      },
      encoding: "utf8",
    });
    result.status = 0;
  } catch (err) {
    result.status = err.status;
    result.stdout = err.stdout ?? "";
    result.stderr = err.stderr ?? "";
  }
  result.calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return result;
};

const RUNNER_ENV = "COMPOSE_PROFILES=runner\nRUNNER_TOKEN=rnr_testtoken\n";

test("--print-agent-image returns the compose default when nothing is set", () => {
  const r = runStubbed(["--print-agent-image"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "ghcr.io/onecli/onecli-agent:latest");
  rmSync(r.home, { recursive: true, force: true });
});

test("--print-agent-image honors RUNNER_AGENT_IMAGE from the env file and the shell", () => {
  const fromFile = runStubbed(["--print-agent-image"], {
    envFile: "RUNNER_AGENT_IMAGE=ghcr.io/acme/agent:9.9.9\n",
  });
  assert.equal(fromFile.stdout.trim(), "ghcr.io/acme/agent:9.9.9");
  rmSync(fromFile.home, { recursive: true, force: true });

  // The shell export is what compose interpolation would use, so it wins.
  const fromShell = runStubbed(["--print-agent-image"], {
    envFile: "RUNNER_AGENT_IMAGE=ghcr.io/acme/agent:9.9.9\n",
    env: { RUNNER_AGENT_IMAGE: "ghcr.io/acme/agent:1.0.0" },
  });
  assert.equal(fromShell.stdout.trim(), "ghcr.io/acme/agent:1.0.0");
  rmSync(fromShell.home, { recursive: true, force: true });
});

test("--print-agent-image tracks a pinned ONECLI_VERSION", () => {
  const r = runStubbed(["--print-agent-image"], {
    env: { ONECLI_VERSION: "2.1.0" },
  });
  assert.equal(r.stdout.trim(), "ghcr.io/onecli/onecli-agent:2.1.0");
  rmSync(r.home, { recursive: true, force: true });
});

test("the installation fingerprint is sha256(token) and uses printf, not echo", async () => {
  const { createHash } = await import("node:crypto");
  const token = "rnr_testtoken";
  const r = runStubbed(["--print-installation-id"], { envFile: RUNNER_ENV });
  assert.equal(r.status, 0);

  const expected = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 32);
  assert.equal(r.stdout.trim(), expected);

  // The mutation test for `printf` vs `echo`: echo appends a newline, which
  // hashes to something else entirely. The sweep would then match no
  // containers while still reporting success, which is the worst possible
  // failure mode here. This assertion is what makes that regression loud.
  const withNewline = createHash("sha256")
    .update(`${token}\n`)
    .digest("hex")
    .slice(0, 32);
  assert.notEqual(r.stdout.trim(), withNewline);
  rmSync(r.home, { recursive: true, force: true });
});

test("--print-installation-id fails when no runner token exists", () => {
  const r = runStubbed(["--print-installation-id"]);
  assert.notEqual(r.status, 0);
  rmSync(r.home, { recursive: true, force: true });
});

test("the reap stops this installation's sandboxes, fenced on BOTH labels", async () => {
  const { createHash } = await import("node:crypto");
  const fp = createHash("sha256")
    .update("rnr_testtoken")
    .digest("hex")
    .slice(0, 32);
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: RUNNER_ENV,
    ids: "abc123\ndef456\n",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^reaped=2$/m);

  const ps = r.calls.find((c) => c.startsWith("ps "));
  assert.ok(ps, "expected a docker ps call");
  assert.ok(
    ps.includes("label=sh.onecli.managed=1"),
    `managed label missing: ${ps}`,
  );
  assert.ok(
    ps.includes(`label=sh.onecli.installation=${fp}`),
    `installation fence missing: ${ps}`,
  );

  assert.deepEqual(
    r.calls.filter((c) => c.startsWith("stop ")),
    ["stop -t 30 abc123", "stop -t 30 def456"],
  );
  rmSync(r.home, { recursive: true, force: true });
});

test("the reap NEVER touches volumes, removes, or prunes", () => {
  // The durable agent homes (onecli-home-*) carry the IDENTICAL label pair as
  // the containers, so this exact filter aimed at `docker volume rm` would
  // erase every agent's /workspace. This is the guard against that.
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: RUNNER_ENV,
    ids: "abc123\n",
  });
  for (const forbidden of ["volume", "rm", "prune", "-v", "down"]) {
    assert.deepEqual(
      r.calls.filter((c) => c.split(" ").includes(forbidden)),
      [],
      `docker was called with "${forbidden}": ${r.calls.join(" | ")}`,
    );
  }
  rmSync(r.home, { recursive: true, force: true });
});

test("ONECLI_KEEP_SANDBOXES leaves every sandbox alone", () => {
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: RUNNER_ENV,
    ids: "abc123\n",
    env: { ONECLI_KEEP_SANDBOXES: "1" },
  });
  assert.match(r.stdout, /^reaped=0$/m);
  assert.match(r.stdout, /^kept=yes$/m);
  assert.deepEqual(r.calls, [], "docker must not be called at all");
  rmSync(r.home, { recursive: true, force: true });
});

test("no runner token means no sweep: the fence is never widened", () => {
  // An unknown installation must NOT fall back to a managed-only filter --
  // that would reap a co-located install's live agents.
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: "COMPOSE_PROFILES=runner\n",
    ids: "abc123\n",
  });
  assert.match(r.stdout, /^reaped=0$/m);
  assert.deepEqual(r.calls, [], "docker must not be called without a fence");
  rmSync(r.home, { recursive: true, force: true });
});

test("an install without hosted agents skips the sweep entirely", () => {
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: "COMPOSE_PROFILES=\nRUNNER_TOKEN=rnr_testtoken\n",
    ids: "abc123\n",
  });
  assert.match(r.stdout, /^reaped=0$/m);
  assert.deepEqual(r.calls, []);
  rmSync(r.home, { recursive: true, force: true });
});

test("a quoted RUNNER_TOKEN hashes to the same fingerprint as a bare one", async () => {
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update("rnr_testtoken")
    .digest("hex")
    .slice(0, 32);
  const r = runStubbed(["--print-installation-id"], {
    envFile: 'RUNNER_TOKEN="rnr_testtoken"\n',
  });
  assert.equal(r.stdout.trim(), expected);
  rmSync(r.home, { recursive: true, force: true });
});

test("--print-compose-url routes pre-2.0 to legacy and everything else to split", () => {
  const legacy = ["1", "1.45", "1.45.0", "v1.44.2"];
  const split = ["2", "2.1.0", "v2.1.0", "latest", ""];
  for (const v of legacy) {
    const r = run(["--print-compose-url"], { ONECLI_VERSION: v });
    assert.match(r.stdout, /docker-compose\.legacy\.yml/, `version ${v}`);
    rmSync(r.home, { recursive: true, force: true });
  }
  for (const v of split) {
    const r = run(["--print-compose-url"], { ONECLI_VERSION: v });
    assert.doesNotMatch(r.stdout, /legacy/, `version ${v}`);
    rmSync(r.home, { recursive: true, force: true });
  }
});

test("the supply-chain guard only pulls references that name a registry", () => {
  // A reference whose first segment has no "." or ":" is not a registry: Docker
  // would resolve `onecli-agent:dev` to docker.io/library/onecli-agent and pull
  // whatever a squatter published there, over the top of a locally built image.
  // Being conservative costs a skipped pull and a printed line; being wrong
  // runs a stranger's code as the agent sandbox.
  const cases = [
    ["ghcr.io/onecli/onecli-agent:2.1.0", "pullable"],
    ["ghcr.io/o/a@sha256:abc", "pullable"],
    ["localhost:5000/foo:1", "pullable"],
    ["myreg:5000/team/img:1", "pullable"],
    ["docker.io/library/onecli-agent:dev", "pullable"],
    // The source-mode tag the wizard builds, and the shapes that would
    // silently become docker.io/library/*.
    ["onecli-agent:dev", "local"],
    ["onecli-agent", "local"],
    ["onecli/onecli-agent:dev", "local"],
    ["localhost/foo:1", "local"],
    ["/foo:1", "local"],
    ["", "local"],
  ];
  for (const [ref, expected] of cases) {
    const r = runStubbed(["--print-ref-pullable", ref]);
    assert.equal(r.stdout.trim(), expected, `ref ${JSON.stringify(ref)}`);
    rmSync(r.home, { recursive: true, force: true });
  }
});

test("a CRLF .env still produces the fingerprint the runner labelled", async () => {
  // WSL is a first-class target and writes CRLF. Compose strips the carriage
  // return; `cut -d= -f2-` does not. Without the trailing-whitespace strip the
  // token hashes as "rnr_x\r", the label filter matches zero containers, and
  // the sweep reports success having done nothing at all. That silent no-op is
  // exactly the failure mode this code's own comment calls the worst one.
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update("rnr_testtoken")
    .digest("hex")
    .slice(0, 32);
  for (const envFile of [
    "RUNNER_TOKEN=rnr_testtoken\r\n",
    'RUNNER_TOKEN="rnr_testtoken"\r\n',
    "RUNNER_TOKEN=rnr_testtoken   \n",
  ]) {
    const r = runStubbed(["--print-installation-id"], { envFile });
    assert.equal(r.stdout.trim(), expected, JSON.stringify(envFile));
    rmSync(r.home, { recursive: true, force: true });
  }
});

test("ONECLI_KEEP_SANDBOXES works from the env file, not just an export", () => {
  // In the documented `curl … | sh` form a variable written in front of curl
  // binds to curl, never to the script, so the .env route has to work.
  const r = runStubbed(["--reap-sandboxes"], {
    envFile: `${RUNNER_ENV}ONECLI_KEEP_SANDBOXES=1\n`,
    ids: "abc123\n",
  });
  assert.match(r.stdout, /^kept=yes$/m);
  assert.deepEqual(r.calls, [], "docker must not be called at all");
  rmSync(r.home, { recursive: true, force: true });
});

// ── SSH front door provisioning (--provision-ssh-env) ──────────────────────
// The real key generation runs inside a node container; here a stubbed docker
// emits fixed fake material so the append-once / single-line-quoted / secret
// / idempotency laws are executable without a daemon.
// The stub emits the fake material verbatim from a file — no JS-string-literal
// layer, so the backslash-n bytes reach the .env exactly as the real node
// container would emit them (each PEM value ONE physical line, internal
// newlines the two-char sequence the wizard's reader and compose cook back).
const BS = String.fromCharCode(92); // a single backslash
const escLine = (key, v) => `${key}="${v.split("\n").join(`${BS}n`)}"`;
const FAKE_MATERIAL =
  [
    escLine("SSH_CA_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nFAKECA\n-----END PRIVATE KEY-----\n"),
    'TERMINATOR_CA_PUBLIC_KEY="ssh-ed25519 FAKECALINE"',
    escLine("TERMINATOR_HOST_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEHOST\n-----END OPENSSH PRIVATE KEY-----\n"),
  ].join("\n") + "\n";
const SSH_DOCKER_STUB = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  "const args = process.argv.slice(2);",
  'appendFileSync(process.env.STUB_LOG, args.join(" ") + "\\n");',
  'if (args[0] === "run") process.stdout.write(readFileSync(process.env.FAKE_MATERIAL, "utf8"));',
  "process.exit(0);",
].join("\n");

const runSshStubbed = (envFile) => {
  const home = mkdtempSync(join(tmpdir(), "onecli-ssh-test-"));
  mkdirSync(join(home, ".onecli"), { recursive: true });
  const envPath = join(home, ".onecli", ".env");
  if (envFile) writeFileSync(envPath, envFile);
  const stub = join(home, "stub-docker.mjs");
  const log = join(home, "docker-calls.log");
  const material = join(home, "fake-material.txt");
  writeFileSync(stub, SSH_DOCKER_STUB);
  writeFileSync(material, FAKE_MATERIAL);
  writeFileSync(log, "");
  const result = { home, envPath };
  try {
    result.stdout = execFileSync("sh", [SCRIPT, "--provision-ssh-env"], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ONECLI_DOCKER_CMD: `node ${stub}`,
        STUB_LOG: log,
        FAKE_MATERIAL: material,
      },
      encoding: "utf8",
    });
    result.status = 0;
  } catch (err) {
    result.status = err.status;
    result.stdout = err.stdout ?? "";
    result.stderr = err.stderr ?? "";
  }
  result.env = readFileSync(envPath, "utf8");
  result.calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return result;
};

test("provisions the SSH front door's coupled key material", () => {
  // provision_ssh_env writes only the coupled material — SSH_TERMINATOR_SECRET
  // is minted unconditionally in the main secret block (door parity), not here.
  const r = runSshStubbed("ONECLI_EXTERNAL_URL=http://box.example:10254\n");
  assert.match(r.env, /^SSH_CA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n/m);
  assert.match(r.env, /^TERMINATOR_CA_PUBLIC_KEY="ssh-ed25519 FAKECALINE"$/m);
  assert.match(r.env, /^TERMINATOR_HOST_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\\n/m);
  // SSH_HOST derives from the external URL's hostname; SSH_PORT is NEVER
  // written here (compose's ONECLI_SSH_PORT is the single knob).
  assert.match(r.env, /^SSH_HOST=box\.example$/m);
  assert.ok(!/^SSH_PORT=/m.test(r.env), "SSH_PORT must not be written by the compose door");
  // Each multi-line PEM is ONE physical line (\n-escaped), never raw newlines.
  for (const line of r.env.split("\n"))
    assert.ok(!line.startsWith("-----"), "a PEM leaked as a raw line: " + line);
  rmSync(r.home, { recursive: true, force: true });
});

test("SSH provisioning is idempotent — a complete set is never re-minted", () => {
  const existing =
    'SSH_CA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nKEEP\\n-----END PRIVATE KEY-----\\n"\n' +
    'TERMINATOR_HOST_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\\nKEEPHOST\\n-----END OPENSSH PRIVATE KEY-----\\n"\n' +
    'TERMINATOR_CA_PUBLIC_KEY="ssh-ed25519 KEEPLINE"\n' +
    "SSH_TERMINATOR_SECRET=keep-this\nSSH_HOST=keep.example\n";
  const r = runSshStubbed(existing);
  assert.match(r.env, /KEEP/);
  assert.match(r.env, /SSH_TERMINATOR_SECRET=keep-this/);
  assert.match(r.env, /SSH_HOST=keep\.example/);
  // The generator container must not have run (the full set is present).
  assert.ok(
    !r.calls.some((c) => c.startsWith("run ")),
    "must not regenerate a complete set",
  );
  rmSync(r.home, { recursive: true, force: true });
});

test("SSH provisioning HEALS a partial set — CA present but host key missing", () => {
  // The exact half-armed state (operator cleared the host key to rotate, or a
  // partial restore) that would otherwise crash-loop the terminator.
  const partial =
    'SSH_CA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nOLD\\n-----END PRIVATE KEY-----\\n"\n' +
    "SSH_TERMINATOR_SECRET=keep-this\n";
  const r = runSshStubbed(partial);
  // The generator ran and the missing coupled lines are now present.
  assert.ok(
    r.calls.some((c) => c.startsWith("run ")),
    "must regenerate to heal a partial set",
  );
  assert.match(r.env, /^TERMINATOR_HOST_KEY=/m);
  assert.match(r.env, /^TERMINATOR_CA_PUBLIC_KEY=/m);
  rmSync(r.home, { recursive: true, force: true });
});
