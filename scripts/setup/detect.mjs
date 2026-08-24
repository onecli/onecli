// Environment detection for `pnpm run setup` — every probe is read-only and
// safe to run repeatedly. The docker-dependent helpers (GID, legacy volume)
// mirror scripts/install.sh, which stays the no-toolchain install path: the
// two front doors must provision identically or an install's behavior would
// depend on which door it came through.

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// The first two probes are ASYNC so the wizard can run them underneath the
// banner animation — detection and the sweep take about the same ~600ms, and
// overlapping them makes the spinner resolve the moment it appears.

export const dockerUp = async () => {
  try {
    await execFile("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
};

/** Containers of the `onecli` compose project (any state). */
export const projectContainers = async () => {
  let out;
  try {
    ({ stdout: out } = await execFile("docker", [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project=onecli",
      "--format",
      "{{.Names}}\t{{.State}}",
    ]));
  } catch {
    return [];
  }
  out = out.trim();
  if (!out) return [];
  return out.split("\n").map((row) => {
    const [name, state] = row.split("\t");
    return { name, state };
  });
};

/**
 * The compose file(s) the RUNNING `onecli` project was started from.
 *
 * Both front doors drive the same project name from different files:
 * scripts/install.sh from ~/.onecli/docker-compose.yml with ~/.onecli/.env,
 * this wizard from the checkout with docker/.env. Those .env files hold
 * DIFFERENT SECRET_ENCRYPTION_KEYs, so recreating an install.sh project from
 * the checkout would leave every stored credential undecryptable. This label
 * is how the wizard tells whose install it is looking at before touching it.
 *
 * Returns `null` when the probe itself could not run, and `[]` when it ran and
 * found nothing. The distinction is load-bearing: a caller that collapses them
 * treats a docker hiccup as permission to proceed, which is exactly the case
 * this probe exists to block.
 */
export const projectConfigFiles = async () => {
  try {
    const { stdout } = await execFile("docker", [
      "ps",
      "--filter",
      "label=com.docker.compose.project=onecli",
      // `.Label "key"`, not `index .Labels "key"`: in `docker ps --format`,
      // .Labels is a comma-joined STRING, so indexing it errors out and the
      // probe would silently report "cannot tell" for every install.
      "--format",
      '{{.Label "com.docker.compose.project.config_files"}}',
    ]);
    return stdout
      .trim()
      .split("\n")
      .flatMap((line) => line.split(","))
      .map((p) => p.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
};

const dockerOut = (args) => {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

/**
 * The bind host for published ports — the publish plane ONLY: it never
 * seeds a URL (ONECLI_EXTERNAL_URL owns the advertise plane). Never
 * 0.0.0.0 by default (that would expose the stack to the network; the
 * wizard's reachability question makes it an explicit choice). Same ladder
 * as install.sh: explicit env, macOS and WSL loopback, the docker0 bridge
 * IP on bare-metal Linux, else "" (the caller must ask).
 */
export const detectBindHost = (env = process.env) => {
  if (env.ONECLI_BIND_HOST) return env.ONECLI_BIND_HOST;
  if (platform() === "darwin") return "127.0.0.1";
  if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return "127.0.0.1";
  try {
    const out = execFileSync("ip", ["-4", "addr", "show", "docker0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)\//);
    if (m) return m[1];
  } catch {
    // no `ip` (macOS) or no docker0 — fall through
  }
  return "";
};

/**
 * The group that owns the docker socket, which the (unprivileged) runner
 * needs to spawn sandboxes. Read from INSIDE a container, not from the host
 * filesystem: on Docker Desktop the host sees a proxy socket whose GID (1 on
 * macOS) has nothing to do with the 0 that containers see, so a host-side
 * stat produces a group that grants nothing and the runner dies with EACCES.
 */
export const detectDockerGid = () => {
  const gid = dockerOut([
    "run",
    "--rm",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "alpine:3.21",
    "stat",
    "-c",
    "%g",
    "/var/run/docker.sock",
  ]);
  return /^\d+$/.test(gid) ? gid : "0";
};

/**
 * Pre-2.0 all-in-one images auto-generated the encryption key inside the
 * app-data volume; the split stack requires it as an env var. Carry it over
 * so an upgraded install keeps decrypting its existing secrets.
 */
export const legacyVolumeSecret = () => {
  try {
    execFileSync("docker", ["volume", "inspect", "onecli_app-data"], {
      stdio: "ignore",
    });
  } catch {
    return "";
  }
  return dockerOut([
    "run",
    "--rm",
    "-v",
    "onecli_app-data:/data:ro",
    "alpine:3.21",
    "cat",
    "/data/secret-encryption-key",
  ]).replace(/[\r\n]/g, "");
};
