// The agent sandbox image build, shared by `pnpm agent:build` and `pnpm dev`.
//
// Two images: docker/agent-base.Dockerfile (the OS surface,
// one big apt layer) and docker/agent.Dockerfile (the app on top, through
// `ARG AGENT_BASE_IMAGE`). The base is tagged exactly what the agent
// Dockerfile defaults to, so the second build needs no arg. Docker caches
// the base after the first run; a code change rebuilds only the thin image.

import { spawnSync } from "node:child_process";

export const AGENT_BASE_TAG = "onecli-agent-base:local";
export const AGENT_DEV_TAG = "onecli-agent:dev";

/** The two `docker build` invocations, in order, as argv (no shell). */
export const agentImageBuilds = (agentTag = AGENT_DEV_TAG) => [
  ["build", "-f", "docker/agent-base.Dockerfile", "-t", AGENT_BASE_TAG, "."],
  ["build", "-f", "docker/agent.Dockerfile", "-t", agentTag, "."],
];

/**
 * Run both builds from `cwd` (the repo root), streaming output. Returns true
 * when both succeeded; stops at the first failure.
 */
export const buildAgentImages = (cwd, agentTag = AGENT_DEV_TAG) =>
  agentImageBuilds(agentTag).every(
    (args) => spawnSync("docker", args, { cwd, stdio: "inherit" }).status === 0,
  );
