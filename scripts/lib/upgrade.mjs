// The Node half of the self-host upgrade decisions, kept pure and
// dependency-free so it is testable without @clack/prompts (which
// scripts/setup/ui.mjs pulls in transitively) and so scripts/install.sh's
// shell half can be compared against it byte for byte.
//
// The shell half lives in scripts/install.sh (`ref_is_pullable`,
// `agent_image_ref`); scripts/upgrade-parity.test.mjs runs both over the same
// inputs and asserts they agree.

import { realpathSync } from "node:fs";

/**
 * Whether a reference names a registry we may pull from.
 *
 * Docker treats the first path segment as a registry only when it contains a
 * "." or a ":". Everything else is a Docker Hub shorthand: `onecli-agent:dev`
 * becomes docker.io/library/onecli-agent, and `myorg/agent:1` becomes
 * docker.io/myorg/agent. Pulling either would fetch whoever owns that name
 * upstream, over the top of a locally built image. Refusing costs a skipped
 * pull and a printed line; accepting runs a stranger's code as the agent
 * sandbox.
 *
 * `localhost/foo` is refused too. That is a real (if unusual) local-registry
 * reference, so this is a false negative, but it fails in the safe direction
 * and the caller says so out loud.
 */
export const isPullableRef = (ref) => {
  if (typeof ref !== "string" || !ref.includes("/")) return false;
  const host = ref.slice(0, ref.indexOf("/"));
  return host.includes(".") || host.includes(":");
};

/**
 * The agent sandbox image this install starts agents from.
 *
 * Precedence matches docker compose interpolation exactly: a shell value beats
 * the env file, for both keys. Getting this wrong is not cosmetic -- the
 * runner reads RUNNER_AGENT_IMAGE through compose, so resolving it differently
 * here would pull one image and then start agents from another.
 *
 * `env` is anything with a `.get(key)` (an EnvFile, or a plain stub in tests).
 */
export const agentImageRef = (env, procEnv = {}) => {
  const fromEnv = (key) => procEnv[key] || env.get(key) || "";
  return (
    fromEnv("RUNNER_AGENT_IMAGE") ||
    `ghcr.io/onecli/onecli-agent:${fromEnv("ONECLI_VERSION") || "latest"}`
  );
};

const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Who owns the compose project that is currently running.
 *
 * Both front doors drive the project name `onecli`, from different files with
 * different SECRET_ENCRYPTION_KEYs, so "whose install is this?" has to be
 * answered before an upgrade recreates anything. Getting it wrong in either
 * direction is expensive: a false "not ours" blocks the documented upgrade
 * command, and a false "ours" makes every stored credential undecryptable.
 *
 * `configFiles` is the com.docker.compose.project.config_files label, split
 * into paths -- or `null` when the probe could not run, which is NOT the same
 * as an empty list and must never be read as permission.
 *
 * Returns one of:
 *   { ours: true }
 *   { ours: false, kind: "probe-failed" }
 *   { ours: false, kind: "nothing-running" }
 *   { ours: false, kind: "installer" | "checkout", owner }
 */
export const composeProjectOwner = (configFiles, { composeDir, homeDir }) => {
  if (configFiles === null) return { ours: false, kind: "probe-failed" };
  if (!configFiles.length) return { ours: false, kind: "nothing-running" };

  // Every compose file this checkout can legitimately drive the project with.
  // docker-compose.dev.yml deliberately shares `name: onecli` so `pnpm dev`
  // reuses the same postgres volume, so a developer with the dev database up
  // is still the owner -- treating them as a stranger would refuse the upgrade
  // command on every development machine.
  const ours = new Set(
    ["docker-compose.yml", "docker-compose.dev.yml", "docker-compose.build.yml"]
      .map((f) => `${composeDir}/${f}`)
      .map(realOrSelf),
  );
  // Realpath both sides: compose records the path as invoked, while Node
  // resolves symlinks, so a checkout reached through a symlinked path (or
  // macOS /tmp -> /private/tmp) would otherwise fail to recognize itself.
  const resolved = configFiles.map(realOrSelf);
  if (resolved.some((p) => ours.has(p))) return { ours: true };

  const owner = resolved[0];
  // Only an install.sh install can be repaired by re-running install.sh. For
  // any OTHER checkout, that advice is destructive: ~/.onecli/.env would not
  // exist, the installer would mint a fresh SECRET_ENCRYPTION_KEY, and every
  // stored credential would stop decrypting.
  const installerHome = realOrSelf(`${homeDir}/.onecli`);
  const kind = resolved.some((p) => p.startsWith(`${installerHome}/`))
    ? "installer"
    : "checkout";
  return { ours: false, kind, owner };
};
