// The Node half of the sandbox restart, used by `pnpm run setup`. The shell
// half lives in scripts/install.sh and is covered by
// scripts/install-sh.test.mjs; scripts/upgrade-parity.test.mjs pins that the
// two halves agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTALLATION_LABEL,
  MANAGED_LABEL,
  installationFingerprint,
  reapSandboxes,
  sandboxFilterArgs,
} from "./sandbox-reap.mjs";

// Same idiom as scripts/migrate-sh.test.mjs: a stub binary that logs every
// invocation, so a test can assert both what ran and what did not. It is a
// real executable (shebang + 0755) because execFileSync takes a binary, not
// a command line.
const DOCKER_STUB = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, args.join(" ") + "\\n");
if (args[0] === "ps") process.stdout.write(process.env.STUB_IDS ?? "");
process.exit(0);
`;

const withStub = (fn, ids = "") => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-reap-test-"));
  const stub = join(dir, "stub-docker.mjs");
  const log = join(dir, "calls.log");
  writeFileSync(stub, DOCKER_STUB);
  chmodSync(stub, 0o755);
  writeFileSync(log, "");
  const previous = { log: process.env.STUB_LOG, ids: process.env.STUB_IDS };
  process.env.STUB_LOG = log;
  process.env.STUB_IDS = ids;
  try {
    const result = fn(stub);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { result, calls };
  } finally {
    if (previous.log === undefined) delete process.env.STUB_LOG;
    else process.env.STUB_LOG = previous.log;
    if (previous.ids === undefined) delete process.env.STUB_IDS;
    else process.env.STUB_IDS = previous.ids;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the fingerprint matches apps/runner/src/installation.ts", () => {
  const token = "rnr_abc123";
  assert.equal(
    installationFingerprint(token),
    createHash("sha256").update(token).digest("hex").slice(0, 32),
  );
  assert.equal(installationFingerprint(token).length, 32);
});

test("the filter always carries BOTH labels", () => {
  const args = sandboxFilterArgs("deadbeef");
  assert.deepEqual(args, [
    "--filter",
    `label=${MANAGED_LABEL}`,
    "--filter",
    `label=${INSTALLATION_LABEL}=deadbeef`,
  ]);
  // A managed-only filter would also match a co-located install's live
  // agents, which is the failure apps/runner/src/installation.ts exists to
  // prevent.
  assert.equal(args.filter((a) => a === "--filter").length, 2);
});

test("keep short-circuits before docker is ever invoked", () => {
  const { result, calls } = withStub(
    (docker) => reapSandboxes({ token: "rnr_x", keep: true, docker }),
    "abc\n",
  );
  assert.deepEqual(result, { stopped: 0, kept: true });
  assert.deepEqual(calls, []);
});

test("a missing token means no sweep: the fence is never widened", () => {
  const { result, calls } = withStub(
    (docker) => reapSandboxes({ token: "", docker }),
    "abc\n",
  );
  assert.deepEqual(result, { stopped: 0, kept: false });
  assert.deepEqual(calls, []);
});

test("nothing running is a clean no-op", () => {
  const { result, calls } = withStub(
    (docker) => reapSandboxes({ token: "rnr_x", docker }),
    "",
  );
  assert.deepEqual(result, { stopped: 0, kept: false });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("stop")),
    [],
  );
});

test("the ps call is fenced on this installation's fingerprint", () => {
  const { calls } = withStub(
    (docker) => reapSandboxes({ token: "rnr_x", docker }),
    "abc123\n",
  );
  const ps = calls.find((c) => c.startsWith("ps "));
  assert.ok(ps, "expected a docker ps call");
  assert.ok(ps.includes(`label=${MANAGED_LABEL}`));
  assert.ok(
    ps.includes(
      `label=${INSTALLATION_LABEL}=${installationFingerprint("rnr_x")}`,
    ),
  );
});

test("stops each matching sandbox gracefully and never touches volumes", () => {
  const { result, calls } = withStub(
    (docker) => reapSandboxes({ token: "rnr_x", docker }),
    "abc123\ndef456\n",
  );
  assert.deepEqual(result, { stopped: 2, kept: false });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("stop")),
    ["stop -t 30 abc123", "stop -t 30 def456"],
  );
  // The durable homes carry the identical label pair, so a destructive verb
  // here would erase every agent's /workspace.
  for (const forbidden of ["volume", "rm", "prune", "-v"])
    assert.deepEqual(
      calls.filter((c) => c.split(" ").includes(forbidden)),
      [],
      `docker was called with "${forbidden}"`,
    );
});
