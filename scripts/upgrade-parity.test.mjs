// The upgrade contract, shared by the two self-host front doors.
//
// scripts/install.sh (POSIX sh, no toolchain) and `pnpm run setup` (Node ESM)
// cannot share an implementation, and scripts/setup/detect.mjs states the rule
// they must both satisfy: "the two front doors must provision identically or
// an install's behavior would depend on which door it came through." This file
// is where that identity is enforced. If you change one door, this fails until
// you change the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLATION_LABEL,
  MANAGED_LABEL,
  installationFingerprint,
} from "./lib/sandbox-reap.mjs";
import { agentImageRef, isPullableRef } from "./lib/upgrade.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const INSTALL_SH = read("scripts/install.sh");
const REAP_MJS = read("scripts/lib/sandbox-reap.mjs");
const RUNNER_INSTALLATION_TS = read("apps/runner/src/installation.ts");
const DOCKER_BACKEND_TS = read(
  "apps/runner/src/backend/docker/docker-backend.ts",
);
const COMPOSE_YML = read("docker/docker-compose.yml");

test("the sources this contract reads are not empty", () => {
  // Canary: every assertion below is a substring search, so a renamed or
  // moved file would make this whole suite vacuously green.
  for (const [name, body] of [
    ["install.sh", INSTALL_SH],
    ["sandbox-reap.mjs", REAP_MJS],
    ["installation.ts", RUNNER_INSTALLATION_TS],
    ["docker-backend.ts", DOCKER_BACKEND_TS],
    ["docker-compose.yml", COMPOSE_YML],
  ])
    assert.ok(body.length > 200, `${name} looks empty or moved`);
});

test("both doors compute the same installation fingerprint", () => {
  const token = "rnr_paritytoken";
  const home = mkdtempSync(join(tmpdir(), "onecli-parity-"));
  mkdirSync(join(home, ".onecli"), { recursive: true });
  writeFileSync(join(home, ".onecli", ".env"), `RUNNER_TOKEN=${token}\n`);
  const fromShell = execFileSync(
    "sh",
    [join(REPO, "scripts/install.sh"), "--print-installation-id"],
    { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" },
  ).trim();
  rmSync(home, { recursive: true, force: true });

  assert.equal(fromShell, installationFingerprint(token));
  assert.equal(
    fromShell,
    createHash("sha256").update(token).digest("hex").slice(0, 32),
  );
});

test("the runner stamps the label both doors filter on", () => {
  // The value side: the runner's own fingerprint must be the same formula.
  assert.match(RUNNER_INSTALLATION_TS, /createHash\("sha256"\)/);
  assert.match(RUNNER_INSTALLATION_TS, /\.slice\(0,\s*32\)/);
  // The key side: the label names are a cross-process contract.
  assert.ok(DOCKER_BACKEND_TS.includes("sh.onecli.installation"));
  assert.ok(DOCKER_BACKEND_TS.includes("sh.onecli.managed"));
});

test("both doors fence the sweep on BOTH labels", () => {
  for (const [name, body] of [
    ["install.sh", INSTALL_SH],
    ["sandbox-reap.mjs", REAP_MJS],
  ]) {
    assert.ok(
      body.includes(MANAGED_LABEL),
      `${name} is missing the managed label`,
    );
    assert.ok(
      body.includes(INSTALLATION_LABEL),
      `${name} is missing the installation fence`,
    );
  }
});

/**
 * Executable lines only. These files DOCUMENT the destructive commands they
 * must never run, so scanning raw source would match the warnings rather than
 * the code they warn about.
 */
const codeOf = (body, comment) =>
  body
    .split("\n")
    .filter((line) => !new RegExp(`^\\s*${comment}`).test(line))
    .join("\n");

test("neither door can destroy a durable home", () => {
  // The onecli-home-* volumes carry the IDENTICAL label pair as the sandbox
  // containers, so the sweep's filter is one careless verb away from erasing
  // every agent's /workspace. No door may RUN a volume-destroying command.
  // `(?<!-)` keeps `docker run --rm -v <read-only mount>` (which this script
  // legitimately uses to read the docker GID and the legacy key) from reading
  // as `docker rm -v <container>`, which destroys the container's volumes.
  const forbidden = [
    /\bvolume\s+rm\b/,
    /\bvolume\s+prune\b/,
    /\bsystem\s+prune\b/,
    /"volume"/,
    /(?<!-)\brm\s+-v\b/,
    /\bdown\s+-v\b/,
  ];
  const doors = [
    ["install.sh", codeOf(INSTALL_SH, "#")],
    ["sandbox-reap.mjs", codeOf(REAP_MJS, "//")],
  ];
  // Canary: if the stripper ever swallowed a file, every assertion below
  // would pass on an empty string.
  for (const [name, code] of doors)
    assert.ok(code.length > 400, `${name}: comment stripping left nothing`);
  for (const [name, code] of doors)
    for (const pattern of forbidden)
      assert.doesNotMatch(code, pattern, `${name} may never run ${pattern}`);
});

test("both doors honor ONECLI_KEEP_SANDBOXES", () => {
  assert.ok(INSTALL_SH.includes("ONECLI_KEEP_SANDBOXES"));
  assert.ok(read("scripts/setup/wizard.mjs").includes("ONECLI_KEEP_SANDBOXES"));
  // And it is documented where an operator would look.
  assert.ok(read("docs/self-hosting.md").includes("ONECLI_KEEP_SANDBOXES"));
});

/** Run one of install.sh's hidden hooks against a scratch HOME and .env. */
const shellHook = (args, envFile = "", env = {}) => {
  const home = mkdtempSync(join(tmpdir(), "onecli-parity-"));
  mkdirSync(join(home, ".onecli"), { recursive: true });
  if (envFile) writeFileSync(join(home, ".onecli", ".env"), envFile);
  try {
    return execFileSync("sh", [join(REPO, "scripts/install.sh"), ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("both doors resolve the SAME agent image, by the same precedence", () => {
  // Behavioral, not a substring search: the doors previously agreed in
  // spelling while disagreeing in PRECEDENCE (the shell honored an export,
  // the wizard read the file only), which would pull one image and start
  // agents on another. Compare real outputs over the same shell+file pairs.
  assert.ok(
    COMPOSE_YML.includes("ghcr.io/onecli/onecli-agent:"),
    "the compose default moved; publish-workflow.test.mjs pins it too",
  );
  // ONECLI_VERSION read from the FILE is deliberately absent here: the two
  // doors legitimately differ on it, and the test below pins that asymmetry
  // rather than papering over it.
  const cases = [
    { file: {}, shell: {} },
    { file: { RUNNER_AGENT_IMAGE: "ghcr.io/acme/a:1" }, shell: {} },
    { file: {}, shell: { ONECLI_VERSION: "2.1.0" } },
    {
      file: { RUNNER_AGENT_IMAGE: "ghcr.io/acme/file:1" },
      shell: { RUNNER_AGENT_IMAGE: "ghcr.io/acme/shell:2" },
    },
  ];
  for (const { file, shell } of cases) {
    const envFile = Object.entries(file)
      .map(([k, v]) => `${k}=${v}\n`)
      .join("");
    const fromShell = shellHook(["--print-agent-image"], envFile, shell);
    const fromNode = agentImageRef({ get: (k) => file[k] }, shell);
    assert.equal(
      fromShell,
      fromNode,
      `doors disagree for file=${JSON.stringify(file)} shell=${JSON.stringify(shell)}`,
    );
  }
});

test("install.sh ignores an .env ONECLI_VERSION pin, and that is correct", () => {
  // The ONE place the doors diverge, pinned so it cannot drift unnoticed.
  // install.sh does `ONECLI_VERSION="${ONECLI_VERSION:-latest}"; export` before
  // every compose call, and a shell value beats the project .env in compose
  // interpolation, so an .env-only pin does not survive that door. Resolving
  // the agent image to `:latest` there is therefore RIGHT: it is exactly what
  // compose interpolates into RUNNER_AGENT_IMAGE for the same run. Making
  // agent_image_ref read the file alone would pull one image and start the
  // runner on another.
  //
  // The wizard exports nothing, so its compose does read docker/.env, and the
  // Node side honors the file. docs/self-hosting.md states both behaviors.
  // Teaching install.sh to honor the pin is a recorded follow-up: it also
  // changes which compose flavor a pinned pre-2.0 install downloads.
  assert.match(INSTALL_SH, /ONECLI_VERSION="\$\{ONECLI_VERSION:-latest\}"/);
  assert.equal(
    shellHook(["--print-agent-image"], "ONECLI_VERSION=2.1.0\n"),
    "ghcr.io/onecli/onecli-agent:latest",
  );
  assert.equal(
    agentImageRef({ get: (k) => ({ ONECLI_VERSION: "2.1.0" })[k] }, {}),
    "ghcr.io/onecli/onecli-agent:2.1.0",
  );
});

test("the wizard actually consults the ownership guard before upgrading", () => {
  // composeProjectOwner is unit-tested in scripts/lib/upgrade.test.mjs, but a
  // tested predicate nobody calls protects nothing: deleting this call site
  // left every other test green. The failure it guards against is silent and
  // unrecoverable (recreating another install's project with this checkout's
  // SECRET_ENCRYPTION_KEY), so the wiring gets pinned too.
  const wizard = codeOf(read("scripts/setup/wizard.mjs"), "//");
  assert.match(
    wizard,
    /composeProjectOwner\(\s*configFiles/,
    "the upgrade path must resolve project ownership from the live probe",
  );
  assert.match(
    wizard,
    /kind === "probe-failed"/,
    "a probe that could not run must be refused, not treated as permission",
  );
});

test("the door-mismatch probe uses a docker ps template that actually works", () => {
  // Caught live, not by review: `docker ps --format` exposes .Labels as a
  // comma-joined STRING, so `index .Labels "k"` fails with "cannot index
  // slice/array with type string". Docker prints the error to stderr and the
  // probe's catch turns it into [], which callers read as "cannot tell" and
  // therefore "do not block". The credential-destroying door mismatch would
  // then sail straight through. `.Label "k"` is the verb that works.
  const detect = codeOf(read("scripts/setup/detect.mjs"), "//");
  assert.ok(
    detect.includes('{{.Label "com.docker.compose.project.config_files"}}'),
    "projectConfigFiles must read the label with .Label",
  );
  assert.doesNotMatch(
    detect,
    /index\s+\.Labels/,
    "index .Labels is a runtime error in docker ps templates",
  );
});

test("both doors make the SAME pull-or-not decision for every reference", () => {
  // The supply-chain guard, compared across the two languages rather than
  // asserted twice. A door that accepted `onecli-agent:dev` would pull
  // docker.io/library/onecli-agent over a locally built image.
  for (const ref of [
    "ghcr.io/onecli/onecli-agent:2.1.0",
    "ghcr.io/o/a@sha256:abc",
    "localhost:5000/foo:1",
    "myreg:5000/team/img:1",
    "docker.io/library/onecli-agent:dev",
    "onecli-agent:dev",
    "onecli-agent",
    "onecli/onecli-agent:dev",
    "localhost/foo:1",
    "/foo:1",
    "",
  ]) {
    const fromShell = shellHook(["--print-ref-pullable", ref]) === "pullable";
    assert.equal(
      fromShell,
      isPullableRef(ref),
      `doors disagree for ${JSON.stringify(ref)}`,
    );
  }
});
