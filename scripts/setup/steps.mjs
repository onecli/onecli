// The provisioning pass: everything `pnpm run setup` writes into docker/.env.
//
// Deliberately ignores the shell environment (unlike `pnpm dev`): compose
// interpolates docker/.env on every future `docker compose` invocation, so an
// install must be complete ON DISK — a value living only in the wizard's
// shell would vanish with it.

import { resolveEnv } from "../lib/env-file.mjs";
import { ensureSecrets } from "../lib/secrets.mjs";
import { ensureSshEnv } from "../lib/ssh-env.mjs";
import {
  detectBindHost,
  detectDockerGid,
  legacyVolumeSecret,
} from "./detect.mjs";
import { SetupError } from "./errors.mjs";
import { log } from "./ui.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Strict validation for the canonical URL only (the legacy APP_URL alias
 * stays lenient): scheme required, plain origin only, never a wildcard bind
 * address. Returns the problem as a string, or undefined when valid — the
 * shape @clack/prompts' validate wants, reused for the SetupError path.
 */
export const externalUrlProblem = (raw) => {
  const value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value))
    return "Write http:// or https:// explicitly (http means ports; https means a proxy in front).";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "Not a valid URL. Use scheme://host[:port].";
  }
  if (url.pathname !== "/" || url.search || url.username)
    return "Use scheme://host[:port] only; subpath serving is unsupported.";
  if (WILDCARD_HOSTS.has(url.hostname))
    return "That is a bind address. Use --bind for where ports publish, and give the address people browse to here.";
  return undefined;
};

/**
 * The addresses the stack will advertise, for the wizard's success note —
 * the same chain the in-container resolver runs: canonical, the legacy
 * APP_URL alias (which never derives the other origins), then the bind seed.
 */
export const resolveDisplayUrls = (envFile) => {
  const appPort = envFile.get("ONECLI_APP_PORT") ?? "10254";
  const apiPort = envFile.get("ONECLI_API_PORT") ?? "10256";
  const gatewayPort = envFile.get("ONECLI_GATEWAY_PORT") ?? "10255";
  const bind = envFile.get("ONECLI_BIND_HOST");
  const canonical = envFile.get("ONECLI_EXTERNAL_URL");
  const alias = envFile.get("APP_URL");
  const external =
    canonical ??
    alias ??
    (bind && !LOOPBACK_HOSTS.has(bind) && !WILDCARD_HOSTS.has(bind)
      ? `http://${bind}:${appPort}`
      : `http://localhost:${appPort}`);
  if (!canonical && alias)
    return {
      external,
      api: `http://localhost:${apiPort}`,
      gateway: `http://localhost:${gatewayPort}`,
    };
  if (external.startsWith("https://"))
    return { external, api: external, gateway: `${external}/gw` };
  let host = "localhost";
  try {
    host = new URL(external).hostname;
  } catch {
    /* keep localhost — the display must never crash the wizard */
  }
  return {
    external,
    api: `http://${host}:${apiPort}`,
    gateway: `http://${host}:${gatewayPort}`,
  };
};

export const provisionEnv = async (envFile, opts) => {
  // The shell is deliberately ignored for WRITES (the file must be complete),
  // but compose itself prefers the shell over the env file at runtime — an
  // exported secret would silently shadow what we write here. Say so.
  for (const key of [
    "SECRET_ENCRYPTION_KEY",
    "BETTER_AUTH_SECRET",
    "GATEWAY_INTERNAL_SECRET",
  ])
    if (process.env[key] !== undefined)
      log.warn(
        `${key} is exported in your shell, so docker compose will prefer it over docker/.env. Unset it before running the stack, or the file's value never applies.`,
      );
  // Legacy carry-over BEFORE generation, same order as install.sh: a pre-2.0
  // install's key must win over a fresh one or its secrets go dark.
  if (!envFile.get("SECRET_ENCRYPTION_KEY")) {
    const legacy = legacyVolumeSecret();
    if (legacy) {
      envFile.upsert("SECRET_ENCRYPTION_KEY", legacy, {
        comment:
          "Carried over from the pre-2.0 install's app-data volume so existing secrets stay decryptable.",
      });
      log.step("Adopted SECRET_ENCRYPTION_KEY from the pre-2.0 volume");
    }
  }

  const { generated, replaced } = ensureSecrets(
    envFile,
    resolveEnv(envFile, {}),
    {},
  );
  if (generated.length) log.step(`Generated ${generated.join(", ")}`);
  for (const key of replaced)
    log.warn(
      `Replaced ${key}: the app rejects the existing value at runtime, so it never encrypted anything.`,
    );

  const existingBind = envFile.get("ONECLI_BIND_HOST");
  if (!existingBind) {
    const bind = opts.bind || detectBindHost();
    if (!bind)
      throw new SetupError(
        "Could not safely determine a bind address for OneCLI.",
        ["Re-run with an explicit address: pnpm run setup --bind=<your-ip>"],
      );
    envFile.upsert("ONECLI_BIND_HOST", bind, {
      comment:
        "Where published ports bind (listen-only; it never shapes a URL). Never 0.0.0.0 by default.",
    });
  } else if (opts.bind && opts.bind !== existingBind)
    log.warn(
      `--bind=${opts.bind} ignored: docker/.env already sets ONECLI_BIND_HOST=${existingBind}; edit the file to change it.`,
    );

  // ── the canonical public URL ──
  // The record of "where do people open OneCLI": an explicit answer is
  // validated and persisted; a non-loopback bind freezes the address the old
  // compose defaults would have advertised (now written down instead of
  // implied); a loopback install gets a self-documenting stub a later
  // upsert un-comments in place.
  const bind = envFile.get("ONECLI_BIND_HOST");
  const appPort = envFile.get("ONECLI_APP_PORT") ?? "10254";
  if (opts.externalUrl) {
    const stripped = opts.externalUrl.trim().replace(/\/+$/, "");
    const problem = externalUrlProblem(stripped);
    if (problem)
      throw new SetupError(`--external-url=${opts.externalUrl}: ${problem}`, [
        "Re-run with the address people browse to, e.g. --external-url=http://192.168.1.20:10254",
      ]);
    const existingUrl = envFile.get("ONECLI_EXTERNAL_URL");
    if (existingUrl && existingUrl !== stripped)
      log.warn(
        `--external-url=${opts.externalUrl} ignored: docker/.env already sets ONECLI_EXTERNAL_URL=${existingUrl}; edit the file to change it.`,
      );
    else if (!existingUrl)
      envFile.upsert("ONECLI_EXTERNAL_URL", stripped, {
        comment:
          "The URL people open OneCLI at; every other address derives from it (http means ports; https means a proxy in front).",
      });
  } else if (!envFile.get("ONECLI_EXTERNAL_URL") && !envFile.get("APP_URL")) {
    if (bind && !LOOPBACK_HOSTS.has(bind) && !WILDCARD_HOSTS.has(bind)) {
      envFile.upsert("ONECLI_EXTERNAL_URL", `http://${bind}:${appPort}`, {
        comment:
          "Frozen at install from the detected bind address; edit to the address people browse to.",
      });
    } else {
      envFile.hintStub("ONECLI_EXTERNAL_URL", `http://localhost:${appPort}`, {
        comment:
          "The URL people open OneCLI at; every other address derives from it.\nhttp means ports; https means a proxy in front. Uncomment to change:",
      });
    }
  }

  // Cross-check: a bind and a URL that disagree about reachability are the
  // two silent misconfigurations this refactor exists to catch — name the
  // symptom, not just the mismatch.
  const finalUrl = envFile.get("ONECLI_EXTERNAL_URL") ?? envFile.get("APP_URL");
  if (finalUrl && bind) {
    let urlHost;
    try {
      urlHost = new URL(finalUrl).hostname;
    } catch {
      urlHost = undefined;
    }
    if (urlHost) {
      const urlIsLoopback = LOOPBACK_HOSTS.has(urlHost);
      const bindIsLoopback = LOOPBACK_HOSTS.has(bind);
      if (bindIsLoopback && !urlIsLoopback)
        log.warn(
          `The URL says ${urlHost} but ports publish only on 127.0.0.1, so nobody at ${urlHost} can reach them. Re-run with --bind=${urlHost} (or a proxy in front) if others should connect directly.`,
        );
      else if (!bindIsLoopback && bind !== "0.0.0.0" && urlIsLoopback)
        log.warn(
          `Ports publish on ${bind} but the URL says ${urlHost}, so emails, Slack buttons and agent links will point at ${urlHost} and only work on this machine.`,
        );
    }
  }

  // Hosted agents are the point — the runner is always on, no question asked
  // (`--no-runner` is the scripted opt-out), with the price named out loud:
  // the runner mounts the Docker socket. An existing COMPOSE_PROFILES line is
  // the operator's choice and is never rewritten; present-empty means
  // deliberately off.
  let profiles = envFile.get("COMPOSE_PROFILES");
  if (profiles === undefined) {
    const list = [];
    if (!opts.noRunner) list.push("runner");
    if (opts.channelAdapter) list.push("channel-adapter");
    profiles = list.join(",");
    envFile.upsert("COMPOSE_PROFILES", profiles, {
      comment:
        "Optional services: runner = hosted agents, channel-adapter = Slack. Empty disables both.",
    });
    log.step(
      opts.noRunner
        ? "Hosted agents off. Set COMPOSE_PROFILES=runner here later to enable them"
        : "Hosted agents enabled (runner profile; the runner mounts the Docker socket to start sandboxes)",
    );
  } else if (opts.noRunner || opts.channelAdapter)
    log.warn(
      "--no-runner/--channel-adapter ignored: docker/.env already sets COMPOSE_PROFILES; edit that line to change the services.",
    );

  // Written unconditionally (matching install.sh): the documented later-enable
  // path is editing COMPOSE_PROFILES in docker/.env, and the runner must not
  // then start with group_add "0" for want of a GID nobody detected.
  if (!envFile.has("DOCKER_GID"))
    envFile.upsert("DOCKER_GID", detectDockerGid(), {
      comment:
        "Group of /var/run/docker.sock as CONTAINERS see it (Docker Desktop's host view is wrong).",
    });

  // SSH into hosted agents rides the runner profile — meaningless without it,
  // and gating here means a --no-runner install advertises no dead door.
  // Provisioned AFTER the external URL is frozen, so SSH_HOST derives from the
  // real hostname (not a stale localhost). Skipped whole on the cloud edition.
  const runnerOn = profiles
    .split(",")
    .map((p) => p.trim())
    .includes("runner");
  if (runnerOn) {
    const { external } = resolveDisplayUrls(envFile);
    let hostname = "localhost";
    try {
      hostname = new URL(external).hostname;
    } catch {
      /* keep localhost — provisioning must never crash the wizard */
    }
    const sshGenerated = ensureSshEnv(envFile, resolveEnv(envFile, {}), {
      hostname,
    });
    if (sshGenerated.length)
      log.step(`Generated ${sshGenerated.join(", ")} (SSH into hosted agents)`);
  }

  return { profiles };
};
