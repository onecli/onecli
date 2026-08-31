#!/usr/bin/env node
// `pnpm dev` — the whole dev stack from one command and one file.
//
// The contract: a fresh clone runs `pnpm install && pnpm dev` and gets a
// working stack. This launcher makes that true by doing, in order: create or
// adopt `.env` (the ONLY env file), generate whatever secrets are missing
// (existing values are sacred), start what it can start (postgres,
// migrations, the prisma client, redis on cloud), skip what it can't (the
// runner, when Docker or the agent image is missing — with one line saying
// how to enable it), and then hand the terminal to turbo, which owns the
// process tree and Ctrl-C.
//
// Precedence is dotenv-cli's rule, kept on purpose: shell env beats `.env`,
// `.env` beats the built-in dev defaults below.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants, homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDevArgs } from "./lib/args.mjs";
import { devExcludeFilters } from "./lib/dev-services.mjs";
import { EnvFile, resolveEnv } from "./lib/env-file.mjs";
import { portBusy } from "./lib/ports.mjs";
import { generatedClientFresh } from "./lib/prisma-client.mjs";
import { ensureDatabaseUrl, ensureSecrets } from "./lib/secrets.mjs";
import { DEFAULT_SSH_PORT, ensureSshEnv } from "./lib/ssh-env.mjs";

// fileURLToPath, not `.pathname`: the latter is percent-encoded, so a repo
// cloned under a path with a space breaks every check and every spawn.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = join(ROOT, ".env");

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const fail = (problem, fix) => {
  console.error(`\n${red("✗")} ${problem}`);
  if (fix) console.error(`  ${fix}\n`);
  process.exit(1);
};
const warn = (problem, fix) => {
  console.error(`${yellow("!")} ${problem}`);
  if (fix) console.error(`  ${dim(fix)}`);
};
const note = (line) => console.log(`${dim("✓")} ${line}`);

/** A spawnSync result's story — including the "binary not found" one. */
const output = (r) =>
  r.error ? String(r.error.message) : `${r.stdout ?? ""}${r.stderr ?? ""}`;
const lastLines = (r, n = 3) =>
  output(r)
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n  ");

// ── the built-in dev defaults ───────────────────────────────────────────────
// What the committed `.env.dev` used to carry: the host-topology facts a
// host-run stack needs and nobody would think to set. Applied ONLY when a key
// is absent from both `.env` and the shell — a present-empty `KEY=` in `.env`
// counts as set (that is how you disable one).
const DEV_DEFAULTS = {
  // How a sandbox dials the runner's control channel: `host.docker.internal`
  // is the container→host name Docker Desktop provides. On Linux it does not
  // resolve — `pnpm dev` warns and you set the docker bridge IP in .env.
  RUNNER_ADVERTISED_HOST: "host.docker.internal",
  // The sandbox network must have a route to the host, because the gateway is
  // a host process here. SECURITY: this turns OFF the sandbox egress boundary
  // for dev sandboxes; compose keeps it on, and so does any real deployment
  // (the runner's own default is `true`).
  RUNNER_NETWORK_INTERNAL: "false",
  // A DIFFERENT network from compose's `onecli-sandboxes`: compose creates
  // that one internal, and a runner that finds an existing internal network
  // where it wanted a routable one only warns and reuses it — dev sandboxes
  // would boot with no route to the gateway.
  RUNNER_SANDBOX_NETWORK: "onecli-sandboxes-dev",
  RUNNER_AGENT_IMAGE: "onecli-agent:dev",
  RUNNER_NAME: "dev",
  // better-auth refuses sign-in/sign-up POSTs from any origin it was not told
  // about, and dev can't enumerate its origins anyway: the dev server proxies
  // the whole stack under itself, and that origin may be an ad-hoc tunnel
  // whose hostname exists for one run. So dev trusts every origin. DEV ONLY:
  // the api ignores this flag outright when NODE_ENV=production.
  DEV_TRUST_ANY_AUTH_ORIGIN: "1",
  // Where the api reads the gateway's CA to put in a sandbox's trust store.
  // The gateway writes it on its first boot; the api re-reads per spawn, so
  // the first run self-heals within one runner poll.
  GATEWAY_CA_PEM_FILE: join(homedir(), ".onecli", "gateway", "ca.pem"),
  CHANNEL_ADAPTER_NAME: "dev",
  // The dev terminator reaches the api over the host loopback (the api is a
  // host process here, like the runner's control-plane URL) and its
  // control-plane token IS the shared SSH_TERMINATOR_SECRET (mapped into the
  // env below, since it is generated, not a static default). It listens on
  // the same port the dashboard advertises as SSH_PORT (10257).
  TERMINATOR_CONTROL_PLANE_URL: "http://localhost:10256",
  TERMINATOR_PORT: DEFAULT_SSH_PORT,
};

const ENV_HEADER = [
  "# OneCLI dev environment — ONE file, maintained by `pnpm dev`.",
  "#",
  "# The launcher fills in anything missing (secrets, DATABASE_URL) and never",
  "# overwrites a value you set. Your shell environment always beats this file.",
  "# The edition is data here too: no EDITION means self-host (onprem); a cloud",
  "# configuration block makes `pnpm dev` run the cloud edition.",
  "# `.env.example` documents the optional settings.",
];

// ── docker-dependent checks (runner plane) ──────────────────────────────────
// Keyed on the directory rather than an edition or a date: the day the runner
// syncs to the OSS mirror, these checks start applying there with no edit.
const runnerInThisCheckout = () =>
  existsSync(join(ROOT, "apps/runner/package.json"));

const dockerUp = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const agentImageBuilt = (image) => {
  try {
    return (
      execFileSync("docker", ["images", "-q", image], {
        encoding: "utf8",
      }).trim() !== ""
    );
  } catch {
    return false;
  }
};

/**
 * One y/n question over plain readline — the launcher stays dependency-free.
 * Returns null when there is no terminal to ask in (the caller falls back to
 * its non-interactive behavior).
 */
const askYesNo = async (question, def = true) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // readline swallows Ctrl-C into an event; without this the prompt would eat it.
  rl.on("SIGINT", () => {
    console.log();
    process.exit(130);
  });
  try {
    const raw = (await rl.question(question)).trim().toLowerCase();
    return raw === "" ? def : raw === "y" || raw === "yes";
  } catch {
    // Ctrl-D / stdin closed mid-question: nobody can answer — same fallback
    // as having no terminal at all.
    console.log();
    return null;
  } finally {
    rl.close();
  }
};

/**
 * Hosted agents need the sandbox image. When it's our own local dev tag,
 * offer to build it on the spot (the exact build `pnpm agent:build` runs) —
 * a custom RUNNER_AGENT_IMAGE isn't ours to build. Returns true when the
 * runner can start.
 */
const offerAgentImageBuild = async (image) => {
  if (image !== "onecli-agent:dev") {
    warn(
      `The agent image ${image} is not available — runner skipped.`,
      "Pull or build it, then re-run pnpm dev.",
    );
    return false;
  }
  const build = await askYesNo(
    `${yellow("?")} Hosted agents need the sandbox image (${image}), which isn't built yet.\n` +
      `  Build it now? One-time, ~3 min — "n" starts everything except hosted agents. [Y/n] `,
  );
  if (build === null) {
    warn(
      `The agent image ${image} is not built — runner skipped.`,
      "Build it once (~3 min): pnpm agent:build",
    );
    return false;
  }
  if (!build) {
    warn(
      "Starting without hosted agents.",
      "Build the image any time: pnpm agent:build",
    );
    return false;
  }
  const b = spawnSync(
    "docker",
    ["build", "-f", "docker/agent.Dockerfile", "-t", image, "."],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (b.status !== 0) {
    warn(
      "The agent image build failed — starting without hosted agents.",
      "Retry with: pnpm agent:build",
    );
    return false;
  }
  note("agent image built — hosted agents enabled");
  return true;
};

// ── postgres ────────────────────────────────────────────────────────────────
const DB_UP_ARGS = [
  "compose",
  "--project-directory",
  ".",
  "-f",
  "docker/docker-compose.dev.yml",
  "up",
  "-d",
  "--wait",
  "postgres",
];

const startPostgres = (mergedEnv) => {
  const r = spawnSync("docker", DB_UP_ARGS, {
    cwd: ROOT,
    encoding: "utf8",
    env: mergedEnv,
  });
  if (r.status !== 0)
    fail("Could not start postgres via docker compose:", lastLines(r));
  note("started postgres (docker compose, onecli-postgres-1)");
};

const checkPostgres = async (mergedEnv) => {
  const url = mergedEnv.DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return warn("DATABASE_URL is not a URL I can parse; skipping the check.");
  }
  const port = Number(parsed.port || 5432);
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(parsed.hostname);
  if (!(await portBusy(port, parsed.hostname))) {
    // Only a LOCAL database is ours to start. A remote one that looks down may
    // be behind a tunnel or VPN this check cannot see.
    if (!local)
      return warn(
        `Postgres at ${parsed.hostname}:${port} did not answer; continuing anyway.`,
      );
    if (!dockerUp())
      fail(
        `Postgres is down on ${parsed.hostname}:${port} and Docker is off.`,
        "Start Docker, or point DATABASE_URL at a running Postgres.",
      );
    startPostgres(mergedEnv);
  }

  // Reachable is not usable: an unmigrated database fails nothing at boot —
  // every request just 500s with "table does not exist".
  const status = spawnSync(
    "pnpm",
    ["--filter", "@onecli/db", "exec", "prisma", "migrate", "status"],
    { cwd: ROOT, encoding: "utf8", env: { ...mergedEnv, DATABASE_URL: url } },
  );
  if (status.status === 0) return;
  if (/have not yet been applied/i.test(output(status))) {
    const deploy = spawnSync(
      "pnpm",
      ["--filter", "@onecli/db", "exec", "prisma", "migrate", "deploy"],
      { cwd: ROOT, encoding: "utf8", env: { ...mergedEnv, DATABASE_URL: url } },
    );
    if (deploy.status !== 0)
      fail("Applying migrations failed:", lastLines(deploy));
    return note("applied pending database migrations");
  }
  // Bad credentials, drift, a failed migration — show what Prisma actually
  // said rather than guessing the fix.
  fail(
    `The database is not ready:\n  ${lastLines(status)}`,
    "Fix the database (or DATABASE_URL in .env) and re-run pnpm dev.",
  );
};

// The generated client is a build artifact `pnpm install` does not produce —
// and one a `git pull` quietly strands: a client generated from an older
// schema still loads and then rejects the new fields at runtime, while the
// migration step above cannot compensate (`migrate deploy`, unlike `migrate
// dev`, never regenerates). So the gate is freshness, not loadability.
const ensurePrismaClient = () => {
  if (generatedClientFresh(join(ROOT, "packages/db"))) return;
  const gen = spawnSync("pnpm", ["--filter", "@onecli/db", "prisma", "generate"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (gen.status !== 0) fail("prisma generate failed:", lastLines(gen));
  note("generated the Prisma client");
};

// ── cloud edition ───────────────────────────────────────────────────────────
// Checked here because the GATEWAY exits on these rather than degrading — and
// it exits after turbo has painted four panes, so the reason scrolls away.
const checkCloudEdition = async (mergedEnv) => {
  const missing = ["COGNITO_USER_POOL_ID", "REDIS_HOST", "KMS_KEY_ARN"].filter(
    (k) => !mergedEnv[k],
  );
  if (missing.length)
    fail(
      `EDITION=cloud requires ${missing.join(", ")} — the gateway exits without ${missing.length > 1 ? "them" : "it"}.`,
      "Set them in .env, or remove the cloud block to run self-host mode.",
    );
  if (!mergedEnv.SECRET_ENCRYPTION_KEY)
    warn(
      "No SECRET_ENCRYPTION_KEY, so the cloud edition encrypts secrets through KMS.",
      "Storing or reading a model key needs working AWS credentials.",
    );
};

// ── redis: who needs it, and starting it ────────────────────────────────────
// Both rules mirror the GATEWAY's own source, so the launcher can never
// disagree with what the gateway will do at boot:
//   entitlement — apps/gateway/crates/common/src/edition.rs `parse_entitled`: trimmed,
//     "true" case-insensitive or exactly "1" (cloud is always entitled);
//   refusal — apps/gateway/crates/ee/ee/src/ha.rs `check_ha_entitlement`: unentitled +
//     non-empty-after-trim REDIS_HOST refuses to boot.
const entitled = (mergedEnv) => {
  const raw = (mergedEnv.ENTERPRISE_ENABLED ?? "").trim();
  return raw.toLowerCase() === "true" || raw === "1";
};

const redisConfigured = (mergedEnv) =>
  (mergedEnv.REDIS_HOST ?? "").trim() !== "";

const ensureRedis = async (mergedEnv) => {
  const host = mergedEnv.REDIS_HOST;
  const port = Number(mergedEnv.REDIS_PORT || 6379);
  // Only a LOCAL redis is ours to start; one already serving needs nothing.
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) || (await portBusy(port)))
    return;
  if (!dockerUp())
    fail(
      `Redis is not accepting connections on ${host}:${port}, and this configuration needs it.`,
      "Start Docker so pnpm dev can start redis, or run redis yourself.",
    );
  // Naming the service activates its compose profile — same dev compose file
  // (and project) as postgres, so it groups and lifecycles with the rest.
  const up = spawnSync(
    "docker",
    ["compose", "--project-directory", ".", "-f", "docker/docker-compose.dev.yml", "up", "-d", "--wait", "redis"],
    { cwd: ROOT, encoding: "utf8", env: mergedEnv },
  );
  if (up.status !== 0) fail("Could not start redis:", lastLines(up));
  note(`started redis (docker compose, onecli-redis-1) on :${port}`);
};

// ── the quiet ones ──────────────────────────────────────────────────────────
const checkPorts = async () => {
  const taken = [];
  for (const [port, who] of [
    [10254, "web"],
    [10255, "gateway"],
    [10256, "api"],
    [8484, "runner control channel"],
    [10257, "ssh terminator"],
  ])
    if (await portBusy(port)) taken.push(`${port} (${who})`);
  if (taken.length)
    warn(
      `Already in use: ${taken.join(", ")} — a compose stack is probably up.`,
      "docker compose -f docker/docker-compose.yml --profile runner down",
    );
};

const checkPlatform = () => {
  if (platform() !== "linux") return;
  warn(
    "On Linux `host.docker.internal` does not resolve from a container.",
    "Set RUNNER_ADVERTISED_HOST and ONECLI_AGENT_PROXY_ADDRESS to the docker bridge (usually 172.17.0.1) in .env.",
  );
};

// ── run ─────────────────────────────────────────────────────────────────────
const main = async () => {
  const { args: userArgs, userFiltered } = normalizeDevArgs(
    process.argv.slice(2),
  );

  // 1 · one .env, created if missing, topped up if incomplete.
  const env = new EnvFile(ENV_PATH, { label: "pnpm dev" });
  if (!env.existed)
    for (const line of ENV_HEADER)
      env.entries.push({ kind: "comment", raw: line });

  const resolved = resolveEnv(env);
  const { generated, replaced, shadowedInvalid } = ensureSecrets(env, resolved);
  ensureDatabaseUrl(env, resolved);
  // Self-host SSH out of the box: mint the CA/host key/secret/host/port so
  // the terminator boots and the dashboard's SSH surface lights up. dev's
  // hostname is always localhost. Skipped whole on the cloud edition.
  const sshGenerated = ensureSshEnv(env, resolved, {
    hostname: "localhost",
    sshPort: DEFAULT_SSH_PORT,
  });
  if (
    env.save() &&
    (generated.length || replaced.length || sshGenerated.length)
  )
    note(
      `generated ${[...generated, ...replaced, ...sshGenerated].join(", ")} → .env`,
    );
  for (const key of replaced)
    warn(
      `${key} in .env was not a usable key (the app rejects it at first use) — replaced it.`,
      "A rejected key never encrypted anything, so nothing is lost.",
    );
  for (const key of shadowedInvalid)
    warn(
      `${key} is exported in your shell with a value the app will reject.`,
      "Unset it (the .env value takes over) or export a valid one.",
    );
  const dupes = env.duplicates();
  if (dupes.length)
    warn(`Duplicate keys in .env (last one wins): ${dupes.join(", ")}`);

  // 2 · the environment the stack will actually see.
  const mergedEnv = { ...DEV_DEFAULTS, ...resolveEnv(env) };
  const isCloud = (mergedEnv.EDITION ?? "").trim().toLowerCase() === "cloud";

  // The terminator's control-plane token is the shared SSH_TERMINATOR_SECRET
  // (one value, two processes — the api verifies what the terminator sends).
  // Mapped here rather than as a static DEV_DEFAULT because it is generated;
  // add-if-absent so a shell override still wins.
  if (mergedEnv.SSH_TERMINATOR_SECRET && !mergedEnv.TERMINATOR_CONTROL_PLANE_TOKEN)
    mergedEnv.TERMINATOR_CONTROL_PLANE_TOKEN = mergedEnv.SSH_TERMINATOR_SECRET;

  // Pre-flight coherence: an unentitled non-cloud config with REDIS_HOST set
  // is GUARANTEED to be refused by the gateway — but only after turbo has
  // painted five panes and the reason has scrolled away. Catch it here.
  if (!isCloud && redisConfigured(mergedEnv) && !entitled(mergedEnv))
    fail(
      "REDIS_HOST is set, but this config is neither the cloud edition nor Enterprise-enabled — the gateway will refuse to boot (self-hosted Redis/HA is licensed).",
      "Pick one in .env: remove REDIS_HOST (default self-host) · EDITION=cloud (cloud dev) · ENTERPRISE_ENABLED=true (licensed self-host)",
    );

  // 3 · adapt to the machine. A user-supplied --filter/-F takes over service
  // selection entirely, so the runner checks only run when we own it.
  let skipRunner = false;
  // The terminator needs ONLY the docker daemon (it execs into agent
  // containers), never the agent image — a separate flag so a declined image
  // build disables the runner but leaves SSH-into-an-agent working. It also
  // must not run unless SSH is actually provisioned (the cloud edition, or an
  // operator who cleared the keys, leaves it unconfigured — a boot ConfigError
  // would take the whole persistent fan-out down).
  let skipTerminator = !mergedEnv.TERMINATOR_HOST_KEY;
  if (!userFiltered && runnerInThisCheckout()) {
    if (!dockerUp()) {
      skipRunner = true;
      skipTerminator = true;
      warn(
        "Docker is down — starting without hosted agents (runner skipped).",
        "Start Docker and re-run pnpm dev to enable them.",
      );
    } else if (!agentImageBuilt(mergedEnv.RUNNER_AGENT_IMAGE)) {
      skipRunner = !(await offerAgentImageBuild(mergedEnv.RUNNER_AGENT_IMAGE));
    }
  }

  await checkPostgres(mergedEnv);
  ensurePrismaClient();
  if (isCloud) await checkCloudEdition(mergedEnv);
  // Redis is needed by exactly two configs — cloud, and an entitled self-host
  // that set REDIS_HOST — and pnpm dev starts what a config needs.
  if (isCloud || (redisConfigured(mergedEnv) && entitled(mergedEnv)))
    await ensureRedis(mergedEnv);
  await checkPorts();
  checkPlatform();

  console.log(
    skipRunner || userFiltered
      ? `${dim("▸")} web :10254   api :10256   gateway :10255${dim(userFiltered ? "" : "   (no runner — hosted agents are off)")}`
      : `${dim("▸")} web :10254   api :10256   gateway :10255   runner :8484` +
          `${skipTerminator ? "" : "   ssh :10257"}` +
          `${dim("   (a sandbox needs a GRANTED model key before it will start)")}`,
  );

  // 4 · hand the terminal to turbo.
  const turboArgs = [
    "run",
    "dev",
    "--ui",
    "stream",
    // Container-only packages never join the host fan-out — see
    // lib/dev-services.mjs. Unconditional (a user filter does not lift it):
    // one such process exiting takes every persistent dev task down with it.
    ...devExcludeFilters(),
    ...(skipRunner ? ["--filter=!@onecli/runner"] : []),
    ...(skipTerminator ? ["--filter=!@onecli/ssh-terminator"] : []),
    ...userArgs,
  ];
  const child = spawn(join(ROOT, "node_modules/.bin/turbo"), turboArgs, {
    cwd: ROOT,
    env: mergedEnv,
    stdio: "inherit",
  });
  child.on("error", (err) =>
    fail(
      `Could not start turbo (${err.code ?? err.message}).`,
      "Run `pnpm install` first — it provides the turbo this launcher hands off to.",
    ),
  );
  // Ctrl-C reaches the whole foreground process group, turbo included — the
  // launcher only has to stay alive until turbo finishes shutting down. A
  // direct SIGTERM/SIGHUP to the launcher is forwarded (no group there).
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"])
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {}
    });
  child.on("exit", (code, signal) =>
    process.exit(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 15) : 0)),
  );
};

await main();
