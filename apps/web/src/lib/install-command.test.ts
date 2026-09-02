import { describe, expect, it } from "vitest";

import {
  CODING_TOOLS,
  buildCliInstallCommand,
  buildRunCommand,
} from "./install-command";

const PROD = {
  apiUrl: "https://api.onecli.sh",
  appUrl: "https://app.onecli.sh",
  apiKey: "oc_key",
};

const DEV = {
  apiUrl: "https://api.dev.example.com",
  appUrl: "https://app.dev.example.com",
  apiKey: "oc_key",
};

describe("buildCliInstallCommand", () => {
  it("prod, tool only — no url, no agent", () => {
    expect(buildCliInstallCommand(PROD, { tool: "claude-code" })).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&tool=claude-code" | sh',
    );
  });

  it("non-prod dashboards carry the url param", () => {
    expect(buildCliInstallCommand(DEV, { tool: "codex" })).toBe(
      'curl -fsSL "https://api.dev.example.com/v1/install/cli?key=oc_key&url=https%3A%2F%2Fapi.dev.example.com&tool=codex" | sh',
    );
  });

  it("a chosen agent rides as agent=<identifier>", () => {
    expect(
      buildCliInstallCommand(PROD, {
        tool: "cursor",
        agentIdentifier: "writer-bot",
      }),
    ).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&tool=cursor&agent=writer-bot" | sh',
    );
  });

  it("no agent option = no agent param (a workspace with no agents renders unpinned commands)", () => {
    expect(buildCliInstallCommand(PROD, { tool: "claude-code" })).not.toContain(
      "agent=",
    );
  });

  it("no tool (the Other pill) omits tool=", () => {
    expect(
      buildCliInstallCommand(PROD, { agentIdentifier: "writer-bot" }),
    ).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&agent=writer-bot" | sh',
    );
  });
});

describe("CODING_TOOLS", () => {
  it("mirrors the CLI's supportedAgents table — nothing made up", () => {
    // cmd/onecli/run.go supportedAgents: the tools with dedicated `onecli run`
    // integration. github-copilot is deliberately absent (legacy-only at the
    // endpoint).
    expect(CODING_TOOLS.map((t) => t.id)).toEqual([
      "claude-code",
      "cursor",
      "codex",
      "hermes",
      "opencode",
      "openclaw",
    ]);
  });

  it("supports multi-word run commands (OpenClaw's daemon)", () => {
    expect(buildRunCommand("openclaw gateway run")).toBe(
      "onecli run -- openclaw gateway run",
    );
    expect(buildRunCommand("openclaw gateway run", "openclaw-bot")).toBe(
      "onecli run --agent openclaw-bot -- openclaw gateway run",
    );
  });
});

describe("buildRunCommand", () => {
  it("plain run when no per-run override is given", () => {
    expect(buildRunCommand("claude")).toBe("onecli run -- claude");
  });

  it("per-run override names the agent", () => {
    expect(buildRunCommand("claude", "writer-bot")).toBe(
      "onecli run --agent writer-bot -- claude",
    );
  });
});
