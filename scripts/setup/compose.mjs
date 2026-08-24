// Driving docker compose for `pnpm run setup`.
//
// All invocations run from the repo root with `-f docker/docker-compose.yml`,
// which makes compose's project directory `docker/` — so `${…}` interpolation
// and `env_file` both read docker/.env, the file the wizard maintains. Long
// operations (pull, build, up) inherit stdio: Docker's own progress output
// beats any spinner we could draw over it.

import { execFileSync, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

import { SetupError } from "./errors.mjs";
import { log, spinner } from "./ui.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const composeArgs = (mode) => [
  "compose",
  "-f",
  "docker/docker-compose.yml",
  ...(mode === "source" ? ["-f", "docker/docker-compose.build.yml"] : []),
];

const run = (args) =>
  spawnSync("docker", args, { cwd: ROOT, stdio: "inherit" });

export const pullImages = (mode) => {
  log.step("Pulling images (docker compose pull)");
  return run([...composeArgs(mode), "pull"]).status === 0;
};

export const buildImages = (mode, { includeAgent = true } = {}) => {
  log.step("Building images from this checkout (docker compose build)");
  if (run([...composeArgs(mode), "build"]).status !== 0)
    throw new SetupError("Building the service images failed.", [
      "Scroll up for the failing build step",
      "Re-run: pnpm run setup --mode=source",
    ]);
  // The agent sandbox image only matters when the runner profile is on — a
  // --no-runner install must neither spend the ~3 min nor be able to FAIL
  // over an image it will never run.
  if (!includeAgent) return;
  log.step("Building the agent sandbox image (docker/agent.Dockerfile)");
  if (
    run([
      "build",
      "-f",
      "docker/agent.Dockerfile",
      "-t",
      "onecli-agent:dev",
      ".",
    ]).status !== 0
  )
    throw new SetupError("Building the agent image failed.", [
      "Scroll up for the failing build step",
      "Hosted agents need this image; retry with: pnpm agent:build",
    ]);
};

export const upStack = (mode) => {
  // `up -d` blocks on the one-shot migrations service completing before it
  // starts the api, so a slow first migration surfaces here, not in healthWait.
  log.step(
    `Running docker ${composeArgs(mode).join(" ")} up -d (applies database migrations first)`,
  );
  if (run([...composeArgs(mode), "up", "-d"]).status !== 0)
    throw new SetupError("docker compose up failed.", [
      `docker ${composeArgs(mode).join(" ")} logs migrations`,
      `docker ${composeArgs(mode).join(" ")} logs --tail 50`,
      `docker ${composeArgs(mode).join(" ")} ps`,
      `docker ${composeArgs(mode).join(" ")} down, then re-run pnpm run setup`,
    ]);
};

const httpOk = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
};

const waitFor = async (url, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await httpOk(url)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

/**
 * The api gates everything (web and gateway wait on its health; migrations
 * have already completed by the time `up -d` returns), so it gets the big
 * first-boot budget and is probed first — a failure there is THE failure to
 * report.
 */
export const healthWait = async ({ bind, apiPort, appPort, mode }) => {
  // A wildcard bind publishes on every interface; probe it via loopback
  // (the same mapping ensurePortsFree uses).
  if (bind === "0.0.0.0") bind = "127.0.0.1";
  const s = spinner();
  s.start("Waiting for OneCLI to come up…");
  if (!(await waitFor(`http://${bind}:${apiPort}/v1/health`, 300_000))) {
    s.stop("The api did not become healthy.");
    throw new SetupError("The api service did not answer /v1/health in time.", [
      `docker ${composeArgs(mode).join(" ")} logs api --tail 50`,
      "Slow disks can exceed the wait. If containers are still starting, just wait and retry the URL",
    ]);
  }
  if (!(await waitFor(`http://${bind}:${appPort}/healthz`, 120_000))) {
    s.stop("The dashboard did not become healthy.");
    throw new SetupError("The web service did not answer /healthz in time.", [
      `docker ${composeArgs(mode).join(" ")} logs web --tail 50`,
    ]);
  }
  s.stop("The api and dashboard are healthy");
};

export const openBrowser = (url) => {
  if (platform() !== "darwin") return;
  try {
    execFileSync("open", [url], { stdio: "ignore" });
  } catch {
    // The URL is printed either way.
  }
};
