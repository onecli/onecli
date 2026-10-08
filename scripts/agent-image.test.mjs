import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the two-image contract of the agent sandbox image: docker/agent-base
// .Dockerfile holds the OS surface (the one big apt layer and everything that
// depends only on it), and docker/agent.Dockerfile stacks the app on top
// through ONE build arg. The failures this prevents: an apt-get creeping back
// into the thin image (every deploy would rebuild and re-ship 600 MB again),
// the thin image losing the arg (the split silently undone), and an ENV the
// sandbox depends on falling between the two files during a move.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const base = read("docker/agent-base.Dockerfile");
const agent = read("docker/agent.Dockerfile");

/** The final stage of a Dockerfile: from its last `FROM` to the end. */
const finalStage = (dockerfile) =>
  dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

/** `ENV KEY=` keys declared in a Dockerfile, in order of first appearance. */
const envKeys = (dockerfile) =>
  [...dockerfile.matchAll(/^ENV ([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);

test("the base image is where apt lives: the ONLY apt-get install of the pair's runtime surface", () => {
  // The base has exactly one install, the big one. Build-only stages of the
  // thin image (the pruner, the jcode and nix vendoring) may still apt-get
  // their own tools; the RUNTIME stage must not, or the 600 MB layer is back.
  assert.equal((base.match(/apt-get install/g) ?? []).length, 1);
  assert.doesNotMatch(finalStage(agent), /apt-get/);
});

test("the thin image stacks on the base through the AGENT_BASE_IMAGE arg, defaulting to the local tag", () => {
  // The default is what `pnpm agent:build` produces first; a deployment and
  // the publish workflow override it with a registry digest.
  assert.match(agent, /^ARG AGENT_BASE_IMAGE=onecli-agent-base:local$/m);
  assert.match(agent, /^FROM \$\{AGENT_BASE_IMAGE\} AS runner$/m);
  // An ARG a FROM line expands must be GLOBAL: declared before the first
  // FROM. Declared between stages it is scoped to the stage above it and
  // the FROM sees a blank name ("base name should not be blank", found
  // on the first local build).
  assert.ok(
    agent.indexOf("\nARG AGENT_BASE_IMAGE=") < agent.indexOf("\nFROM "),
    "AGENT_BASE_IMAGE must be declared before the first FROM",
  );
  assert.equal((agent.match(/^ARG AGENT_BASE_IMAGE/gm) ?? []).length, 1);
  // A digest-less default is fine locally; the base must never be pulled
  // by a mutable tag from a registry in this file.
  assert.doesNotMatch(agent, /^FROM .*agent-base:(latest|base-latest)/m);
});

test("the base image is the OS surface only: no repo source, no app, no user switch", () => {
  // Nothing from the build context enters the base: it is the same bytes
  // whatever commit builds it, which is what makes its content-hash tag
  // honest. The one exception is nothing at all.
  assert.doesNotMatch(base, /^COPY /m);
  assert.doesNotMatch(base, /^ADD /m);
  // The thin image is the one that drops privileges and sets the command;
  // a USER in the base would make its own RUNs (root-owned config, setuid
  // bits) fail, and a CMD there would hide a thin image that forgot its own.
  assert.doesNotMatch(base, /^USER /m);
  assert.doesNotMatch(base, /^CMD /m);
  assert.match(finalStage(agent), /^USER node$/m);
  assert.match(finalStage(agent), /^CMD \["\.\/agent-entrypoint\.sh"\]$/m);
  // PID 1 is the base's (tini comes from apt); the thin image must not
  // redefine it to something the base did not install.
  assert.match(base, /^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  assert.doesNotMatch(finalStage(agent), /^ENTRYPOINT /m);
});

test("every ENV the sandbox runs with is declared in exactly one of the two files", () => {
  // The set the one-file image carried before the split (the last
  // docker/agent.Dockerfile that held both halves): a key missing from both
  // files is a sandbox that silently changed behavior; a key in both is a
  // conflict waiting for an ordering bug.
  const expected = [
    "NODE_ENV",
    "NO_COLOR",
    "FORCE_COLOR",
    "JCODE_NO_TELEMETRY",
    "JCODE_NO_AUTO_UPDATE",
    "APP_VERSION",
    "NODE_OPTIONS",
    "XDG_RUNTIME_DIR",
    "CONTAINERS_STORAGE_CONF",
    "NPM_CONFIG_PREFIX",
    "PIP_BREAK_SYSTEM_PACKAGES",
    "EDITOR",
    "PAGER",
    "LESS",
    "ONECLI_JCODE_BINARY",
  ];
  const inBase = envKeys(base);
  const inAgent = envKeys(finalStage(agent));
  for (const key of expected) {
    const count = Number(inBase.includes(key)) + Number(inAgent.includes(key));
    assert.equal(count, 1, `${key}: declared ${count} times across the pair`);
  }
  // No surprise additions either (an ENV is part of the sandbox's contract).
  assert.deepEqual(
    new Set([...inBase, ...inAgent]),
    new Set(expected),
    "the ENV set changed; update this pin deliberately",
  );
});

test("the base pins its own base image the same way the thin image did (no floating tag)", () => {
  assert.match(base, /^FROM node:22\.23\.2-trixie-slim$/m);
  // The thin image's build stages keep the same pin, so the app is built
  // and run on the same Node and glibc the base ships.
  assert.match(agent, /^FROM node:22\.23\.2-trixie-slim AS base$/m);
});

test("the browser README routes browsers to the open proxy and the image can act on a human check", () => {
  // The in-image README is the one source the machine fragment defers to,
  // so its proxy paragraph must say what the fragment says: browsers use
  // the open proxy by the variable (never a hard-coded port), the gateway
  // proxy stays the API path and the deliberate exception.
  assert.match(base, /The open proxy, in OPEN_PROXY/);
  assert.match(base, /proxy: \{ server: process\.env\.OPEN_PROXY \}/);
  assert.match(base, /read' \\\n\s+'\s+the variable, never assume the number/);
  assert.match(base, /The gateway proxy, in HTTPS_PROXY/);
  assert.match(base, /The open proxy injects nothing/);
  // The human-check posture needs a real cursor on the virtual display:
  // xdotool is installed in the one apt layer and proven at build time.
  assert.match(base, /^\s+dbus-x11 chromium chromium-sandbox xvfb xdotool /m);
  assert.match(base, /&& xdotool --version >\/dev\/null \\/);
  assert.match(base, /Human checks: some sites answer a browser/);
});

test("login shells learn the open proxy from the supervisor's published URL, loopback only", () => {
  // An SSH session is a fresh exec that never inherits the supervisor's
  // environment; the profile drop-in reads the boot-owned URL file. The
  // guard is the security line: only exactly http://127.0.0.1:<digits> is
  // exported, so a value planted in /tmp can never point a browser
  // off-machine. Pinned by RUNNING the snippet, not by reading it: the
  // printf'd lines are extracted, the file path is swapped for a temp file,
  // and sh evaluates it against planted values.
  const profile = base.slice(
    base.indexOf("RUN usermod -d /workspace/.home node"),
    base.indexOf("> /etc/profile.d/onecli-path.sh"),
  );
  const snippet = [...profile.matchAll(/^\s+'(.*)' \\$/gm)]
    .map((m) => m[1].replaceAll(`'"'"'`, "'"))
    .join("\n");
  assert.match(snippet, /onecli-open-proxy\.url/);

  const dir = mkdtempSync(join(tmpdir(), "agent-image-"));
  const urlFile = join(dir, "open-proxy.url");
  const script = snippet.replaceAll("/tmp/onecli-open-proxy.url", urlFile);
  const exported = (planted, env = {}) => {
    writeFileSync(urlFile, `${planted}\n`);
    return execFileSync(
      "sh",
      ["-c", `${script}\nprintf '%s' "\${OPEN_PROXY:-unset}"`],
      { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
    );
  };
  try {
    assert.equal(exported("http://127.0.0.1:3128"), "http://127.0.0.1:3128");
    assert.equal(exported("http://127.0.0.1:3129"), "http://127.0.0.1:3129");
    // Planted values: a port that continues into another host, a non-loopback
    // host, a scheme change, trailing garbage, an empty file.
    for (const bad of [
      "http://127.0.0.1:3128@evil.example",
      "http://127.0.0.1:3128/evil",
      "http://127.0.0.1.evil.example:3128",
      "http://10.0.0.1:3128",
      "https://127.0.0.1:3128",
      "http://127.0.0.1:",
      "",
    ]) {
      assert.equal(exported(bad), "unset", `planted ${JSON.stringify(bad)}`);
    }
    // An already-set OPEN_PROXY (the supervisor's own children) is left alone.
    assert.equal(
      exported("http://127.0.0.1:3128", { OPEN_PROXY: "http://127.0.0.1:9" }),
      "http://127.0.0.1:9",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
