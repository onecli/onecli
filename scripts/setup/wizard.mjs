// The `pnpm run setup` flow: detect → existing-config fork → run mode →
// provision docker/.env → images → up → health → done.
//
// Rerunning is the designed way to change anything: every write is
// generate-or-reuse, so a second run keeps a working install working.

import { renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvFile, resolveEnv } from "../lib/env-file.mjs";
import { portBusy, portOwner } from "../lib/ports.mjs";
import { reapSandboxes } from "../lib/sandbox-reap.mjs";
import { composeProjectOwner } from "../lib/upgrade.mjs";
import { showBanner } from "./banner.mjs";
import {
  agentImageRef,
  buildImages,
  composeArgs,
  healthWait,
  isPullableRef,
  openBrowser,
  pullAgentImage,
  pullImages,
  upStack,
} from "./compose.mjs";
import { dockerUp, projectConfigFiles, projectContainers } from "./detect.mjs";
import { SetupError } from "./errors.mjs";
import {
  externalUrlProblem,
  provisionEnv,
  resolveDisplayUrls,
} from "./steps.mjs";
import {
  askConfirm,
  askSelect,
  askText,
  log,
  note,
  outro,
  spinner,
} from "./ui.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENV_PATH = join(ROOT, "docker", ".env");

const resolvedPorts = (env) => {
  const r = resolveEnv(env, {});
  return {
    bind: r.ONECLI_BIND_HOST || "127.0.0.1",
    appPort: r.ONECLI_APP_PORT || "10254",
    gatewayPort: r.ONECLI_GATEWAY_PORT || "10255",
    apiPort: r.ONECLI_API_PORT || "10256",
    postgresPort: r.POSTGRES_PORT || "5432",
  };
};

/**
 * Nothing may squat the published ports — except our own stack, which a rerun
 * legitimately finds running (compose recreates what changed). So the check
 * only runs when the project has no live containers.
 */
const ensurePortsFree = async (env, opts) => {
  const { bind, appPort, gatewayPort, apiPort, postgresPort } =
    resolvedPorts(env);
  const watched = [
    [appPort, "dashboard"],
    [gatewayPort, "gateway"],
    [apiPort, "api"],
    [postgresPort, "postgres"],
  ];
  for (;;) {
    const conflicts = [];
    for (const [port, who] of watched)
      if (await portBusy(Number(port), bind === "0.0.0.0" ? "127.0.0.1" : bind))
        conflicts.push([port, who]);
    if (!conflicts.length) return;

    const named = conflicts
      .map(([port, who]) => {
        const owner = portOwner(port);
        return `:${port} (${who})${owner ? ` held by ${owner.command} (pid ${owner.pid})` : ""}`;
      })
      .join(", ");
    if (opts.yes)
      throw new SetupError(`Ports in use: ${named}.`, [
        "Stop what holds them, or pick other ports in docker/.env (ONECLI_APP_PORT, ONECLI_GATEWAY_PORT, ONECLI_API_PORT, POSTGRES_PORT)",
      ]);
    const action = await askSelect({
      message: `Ports in use: ${named}`,
      options: [
        { value: "recheck", label: "I've stopped it. Check again" },
        {
          value: "abort",
          label: "Stop setup",
          hint: "pick other ports in docker/.env (ONECLI_*_PORT), then re-run",
        },
      ],
      initialValue: "recheck",
    });
    if (action === "abort")
      throw new SetupError(`Ports in use: ${named}.`, [
        "Set ONECLI_APP_PORT / ONECLI_GATEWAY_PORT / ONECLI_API_PORT / POSTGRES_PORT in docker/.env, then re-run pnpm run setup",
      ]);
  }
};

export const runWizard = async (opts) => {
  // Detection is subprocess work and the banner is ~1s of animation with
  // nothing to do — overlap them so the spinner below resolves at once.
  const detecting = (async () => {
    const docker = await dockerUp();
    const running = (docker ? await projectContainers() : []).filter(
      (c) => c.state === "running",
    );
    const configFiles = running.length ? await projectConfigFiles() : [];
    return { docker, running, configFiles };
  })();
  await showBanner({ animate: !opts.yes });

  const s = spinner();
  s.start("Looking at what you already have…");
  const { docker, running, configFiles } = await detecting;
  let env = new EnvFile(ENV_PATH, { label: "pnpm run setup" });
  s.stop(
    `Detected: docker ${docker ? "✓" : "✗"} · ${env.existed ? "existing install config" : "no existing install"}${running.length ? ` · ${running.length} service(s) running` : ""}`,
  );

  // ── existing config: keep / upgrade / review / reset ──
  let reviewing = false;
  let upgrading = Boolean(opts.upgrade);
  if (env.existed) {
    // --upgrade is not just a shortcut: off-TTY runs are rejected outright and
    // --yes makes askSelect return its initialValue silently, so a flag is the
    // only way a scripted run can reach the upgrade path at all.
    const action = upgrading
      ? "upgrade"
      : await askSelect({
          message: "Found an existing docker/.env. What should we do?",
          options: [
            {
              value: "keep",
              label: "Keep it",
              hint: "reuse every value and just (re)start the stack",
            },
            {
              value: "upgrade",
              label: "Upgrade",
              hint: "pull the newest images and restart running agents onto them",
            },
            {
              value: "review",
              label: "Review and update",
              hint: "walk setup again; current values are kept",
            },
            {
              value: "reset",
              label: "Reset",
              hint: "archive docker/.env and start fresh",
            },
          ],
          initialValue: "keep",
        });
    if (action === "reset") {
      const backup = `${ENV_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(ENV_PATH, backup);
      log.step(`Archived the old config to ${backup}`);
      env = new EnvFile(ENV_PATH, { label: "pnpm run setup" });
    }
    // Upgrading is deliberately NOT reviewing: it must not reopen the URL and
    // bind questions, which is all "review" means here.
    reviewing = action === "review" || action === "reset";
    upgrading = action === "upgrade";
  }

  // The running project may belong to a DIFFERENT install. Every front door
  // drives the compose project `onecli`, but from different files with
  // different SECRET_ENCRYPTION_KEYs, so recreating someone else's project
  // from here would leave every stored credential undecryptable. Refuse, and
  // name a remedy that is actually safe for whoever owns it.
  if (upgrading) {
    const owner = composeProjectOwner(configFiles, {
      composeDir: join(ROOT, "docker"),
      homeDir: homedir(),
    });
    if (owner.kind === "probe-failed")
      throw new SetupError(
        "Could not determine which install owns the running OneCLI stack.",
        [
          "The docker probe for the com.docker.compose.project.config_files label failed",
          "Upgrading without that answer could recreate another install's stack with this checkout's docker/.env, and every credential it stored would stop decrypting",
          "Check that `docker ps` works, then re-run",
        ],
      );
    if (!owner.ours && owner.kind !== "nothing-running")
      throw new SetupError(
        "The OneCLI stack running on this machine was not started from this checkout.",
        [
          `It runs from: ${owner.owner}`,
          "That install's own env file holds the SECRET_ENCRYPTION_KEY its data is encrypted with; upgrading from here would recreate the stack with this checkout's key instead, and every stored credential would stop decrypting",
          owner.kind === "installer"
            ? "Upgrade it with the installer that owns it: curl -fsSL https://onecli.sh/install | sh"
            : `Upgrade it from the checkout that owns it: cd ${dirname(dirname(owner.owner))} && pnpm run setup --upgrade`,
        ],
      );
  }

  // ── run mode ──
  const recorded = env.get("ONECLI_SETUP_MODE");
  let mode = opts.mode;
  if (!mode && env.existed && !reviewing) mode = recorded ?? "compose";
  if (!mode)
    mode = await askSelect({
      message: "How do you want to run OneCLI?",
      options: [
        {
          value: "compose",
          label: "Docker Compose (published images)",
          hint: docker
            ? "the fastest way to run OneCLI"
            : "Docker is NOT running",
        },
        {
          value: "source",
          label: "Docker Compose (build from source)",
          hint: docker
            ? "build the images from this checkout"
            : "Docker is NOT running",
        },
      ],
      initialValue: recorded ?? "compose",
    });

  if (!docker)
    throw new SetupError("Docker is not running, and this mode needs it.", [
      "Start Docker Desktop (or OrbStack / your docker daemon) and re-run pnpm run setup",
      "No Docker at all? https://docs.docker.com/get-docker/",
    ]);

  // ── networking (the two questions) ──
  // Q1 decides the canonical URL; Q2 the publish plane. Asked only when the
  // file answers neither (a kept config is the operator's choice) and no
  // flag pre-answered them; --yes takes the defaults silently.
  let externalUrl = opts.externalUrl;
  let bindChoice = opts.bind;
  const askNetworking = !env.existed || reviewing;
  if (
    askNetworking &&
    !externalUrl &&
    !env.get("ONECLI_EXTERNAL_URL") &&
    !env.get("APP_URL")
  ) {
    const defaultUrl = `http://localhost:${env.get("ONECLI_APP_PORT") ?? "10254"}`;
    const answer = await askText({
      message:
        "Where will people open OneCLI? (every link and origin derives from this URL)",
      initialValue: defaultUrl,
      validate: (value) => (value ? externalUrlProblem(value) : undefined),
    });
    // The localhost default stays a hint stub rather than a pinned value, so
    // the file self-documents without freezing an address nobody chose.
    if (answer && answer.trim().replace(/\/+$/, "") !== defaultUrl)
      externalUrl = answer;
  }
  if (askNetworking && !bindChoice && !env.get("ONECLI_BIND_HOST")) {
    const reach = await askSelect({
      message: "Who should reach this machine's ports directly?",
      options: [
        {
          value: "local",
          label: "Only this machine",
          hint: "bind to the detected local address (tunnels and proxies still work)",
        },
        {
          value: "network",
          label: "Other machines too",
          hint: "bind to 0.0.0.0 (put a firewall or proxy in front)",
        },
      ],
      initialValue: "local",
    });
    if (reach === "network") bindChoice = "0.0.0.0";
  }

  // ── provision docker/.env ──
  const { profiles } = await provisionEnv(env, {
    ...opts,
    externalUrl,
    bind: bindChoice,
  });
  env.upsert("ONECLI_SETUP_MODE", mode, {
    comment:
      "How this install runs (compose = published images, source = built here).",
  });
  if (env.save())
    log.step(
      "Wrote docker/.env (compose reads it for interpolation, the services via env_file)",
    );

  // ── images ──
  if (mode === "compose" && !pullImages(mode)) {
    log.warn(
      "Could not pull the published images. They may not be published for this version yet.",
    );
    if (opts.yes)
      throw new SetupError("The published images are not pullable.", [
        "Build from source instead: pnpm run setup --yes --mode=source",
      ]);
    const fallback = await askConfirm({
      message: "Build the images from this checkout instead?",
      initialValue: true,
    });
    if (!fallback)
      throw new SetupError("The published images are not pullable.", [
        "Check your network, or re-run with --mode=source",
      ]);
    mode = "source";
  }
  // The agent sandbox image is not a compose service, so the pull above could
  // not have fetched it. This runs on EVERY compose-mode setup, not only an
  // upgrade: `pullImages` already moves the six services forward, and leaving
  // the agent image behind is exactly the drift being fixed here. Source mode
  // skips it, because buildImages below rebuilds it from this checkout.
  if (mode === "compose" && profiles.includes("runner")) {
    const ref = agentImageRef(env, process.env);
    if (!isPullableRef(ref)) {
      // Not necessarily "built locally": a two-segment ref like myorg/agent:1
      // is a real Docker Hub reference we refuse on purpose, since pulling it
      // could replace a locally built image from a namespace we do not own.
      log.step(
        `Agent sandbox image ${ref} names no registry host, so it is not pulled`,
      );
    } else if (!pullAgentImage(ref)) {
      log.warn(
        `Could not pull ${ref}. OneCLI will still start, but hosted agents keep using the agent image already on this host.`,
      );
    }
  }
  if (mode === "source") {
    // However source mode was reached — chosen up front or as the
    // pull-failure fallback — the runner must use the locally built agent
    // tag: the compose default points at the very registry that may have
    // just failed to pull.
    if (!env.has("RUNNER_AGENT_IMAGE"))
      env.upsert("RUNNER_AGENT_IMAGE", "onecli-agent:dev", {
        comment: "Built from this checkout by pnpm run setup (source mode).",
      });
    env.upsert("ONECLI_SETUP_MODE", "source");
    env.save();
    buildImages(mode, { includeAgent: profiles.includes("runner") });
  }

  // ── up + health ──
  if (!running.length) await ensurePortsFree(env, opts);
  upStack(mode);
  const { bind, appPort, gatewayPort, apiPort } = resolvedPorts(env);
  await healthWait({ bind, apiPort, appPort, mode });

  // Move running agents onto the image we just pulled. Sandboxes are runner
  // created containers with no compose labels, so `up` never replaces them:
  // without this they keep running the old agent image indefinitely. Only on
  // an explicit upgrade, because it interrupts whatever an agent is doing.
  let reaped = { stopped: 0, kept: false };
  if (upgrading && profiles.includes("runner")) {
    const resolved = resolveEnv(env, process.env);
    reaped = reapSandboxes({
      token: resolved.RUNNER_TOKEN,
      // Shell value or docker/.env line, same as install.sh reads it, so the
      // documented escape hatch behaves identically at both doors.
      keep: Boolean(resolved.ONECLI_KEEP_SANDBOXES),
    });
    if (reaped.kept)
      log.step(
        "Left running agent sandboxes alone (ONECLI_KEEP_SANDBOXES is set)",
      );
    else if (reaped.stopped)
      log.step(
        `Restarted ${reaped.stopped} agent sandbox(es) onto the new image`,
      );
  }

  // Display the ADVERTISED addresses (what the resolver serves the browser),
  // not the publish plane — the two are decoupled now. The browser open
  // stays on the locally reachable address: the wizard runs on this machine,
  // where the external URL may be a domain that only resolves elsewhere.
  const advertised = resolveDisplayUrls(env);
  // Open the browser on the ADVERTISED host when the bind is local-only:
  // first-run sign-in then happens on the same origin every injected URL and
  // cookie names (localhost), instead of its 127.0.0.1 twin.
  const localUrl =
    bind === "0.0.0.0" || bind === "127.0.0.1"
      ? `http://localhost:${appPort}`
      : `http://${bind}:${appPort}`;
  note(
    [
      `Dashboard  ${advertised.external}`,
      `Gateway    ${advertised.gateway}`,
      `API        ${advertised.api}`,
      "",
      "Create your account right away. The first account owns the instance.",
      "",
      `Stop:    docker ${composeArgs(mode).join(" ")} down`,
      "Update:  git pull && pnpm install && pnpm run setup --upgrade",
    ].join("\n"),
    "OneCLI is running",
  );
  outro("Setup complete.");
  openBrowser(localUrl);
};
