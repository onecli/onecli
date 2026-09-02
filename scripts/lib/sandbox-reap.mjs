// Restarting an installation's agent sandboxes so they pick up a new image.
//
// Agent sandboxes are containers the runner creates through the Docker API,
// not compose services. They therefore carry none of the `com.docker.compose.*`
// labels, and `docker compose down`/`up` never touches them: after an upgrade
// they keep running the OLD agent image until something stops them. Both
// self-host front doors (scripts/install.sh and `pnpm run setup`) call the
// same logic, which is why it lives here rather than in scripts/setup/ -- this
// module must stay dependency-free so its tests run without @clack/prompts.
//
// Two invariants govern everything below.
//
// FENCE ON BOTH LABELS. `sh.onecli.managed=1` alone also matches a co-located
// installation's containers; pairing it with `sh.onecli.installation` is what
// keeps one stack from reaping another's live agents. This mirrors the
// runner's own orphan sweep, and apps/runner/src/installation.ts explains why
// the identity exists at all. No fingerprint means no sweep: an unknown
// installation is never a reason to widen the filter.
//
// CONTAINERS ONLY. The durable home volumes (onecli-home-<sandboxId>) carry
// the IDENTICAL label pair, so this exact filter aimed at `docker volume rm`
// would erase every agent's /workspace. Nothing here may ever use `volume`,
// `rm -v`, or a prune, and a test asserts those calls are never made.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const MANAGED_LABEL = "sh.onecli.managed=1";
export const INSTALLATION_LABEL = "sh.onecli.installation";

/**
 * A stable, non-secret fingerprint of THIS installation, derived from the
 * runner's registration token.
 *
 * Byte-equal with `installationFingerprint` in apps/runner/src/installation.ts
 * and with `installation_fingerprint` in scripts/install.sh. The runner stamps
 * this value onto every sandbox container it creates, so all three must agree
 * exactly or the filter silently matches nothing.
 */
export const installationFingerprint = (token) =>
  createHash("sha256").update(token).digest("hex").slice(0, 32);

/**
 * The `docker ps` filter that selects exactly this installation's sandbox
 * containers. Exported so a test can assert both doors use the same pair.
 */
export const sandboxFilterArgs = (fingerprint) => [
  "--filter",
  `label=${MANAGED_LABEL}`,
  "--filter",
  `label=${INSTALLATION_LABEL}=${fingerprint}`,
];

/**
 * Stop this installation's running sandboxes.
 *
 * Returns `{ stopped, kept }`: how many containers were stopped, and whether
 * the operator opted out. Best effort throughout -- a failed stop leaves an
 * agent on the old image until it next restarts, which is not worth failing an
 * otherwise successful upgrade over.
 *
 * `stop`, not `rm`: the runner recreates a sandbox container from the current
 * image on the agent's next message either way, and a stopped container is
 * reported to the control plane on the very next reconcile pass, where a
 * removed one has to be noticed as vanished across two.
 */
export const reapSandboxes = ({
  token,
  keep = false,
  docker = "docker",
} = {}) => {
  if (keep) return { stopped: 0, kept: true };
  if (!token) return { stopped: 0, kept: false };

  const run = (args) => {
    try {
      return execFileSync(docker, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };

  const ids = run([
    "ps",
    "-q",
    ...sandboxFilterArgs(installationFingerprint(token)),
  ])
    .split("\n")
    .filter(Boolean);
  if (!ids.length) return { stopped: 0, kept: false };

  let stopped = 0;
  for (const id of ids) {
    try {
      // -t 30 matches the runner's own graceful stop timeout.
      execFileSync(docker, ["stop", "-t", "30", id], { stdio: "ignore" });
      stopped += 1;
    } catch {
      // Already gone, or held by something else. Best effort.
    }
  }
  return { stopped, kept: false };
};
