// The single source for the CLI setup commands shown in the dashboard (the
// Install page and the onboarding install step). Pure string building — the
// callers decide edition gating (IS_CLOUD) and which agent, if any, to pin.

export const PROD_APP_URL = "https://app.onecli.sh";

export interface CodingTool {
  id: string;
  name: string;
  runAlias: string;
  icon: string;
}

// `id` is the install endpoint's `tool=` value. This list mirrors the CLI's
// `supportedAgents` table (cmd/onecli/run.go) — the tools `onecli run` gives
// dedicated gateway integration (skills/hooks/proxy config). Anything else
// still runs generically via the Other pill. Keep in lockstep with the install
// endpoint's VALID_TOOLS list (GET /v1/install/cli, cloud-hosted).
export const CODING_TOOLS = [
  {
    id: "claude-code",
    name: "Claude Code",
    runAlias: "claude",
    icon: "/icons/claude-code.svg",
  },
  {
    id: "cursor",
    name: "Cursor",
    runAlias: "cursor",
    icon: "/icons/cursor.svg",
  },
  { id: "codex", name: "Codex", runAlias: "codex", icon: "/icons/codex.svg" },
  {
    id: "hermes",
    name: "Hermes",
    runAlias: "hermes",
    icon: "/icons/hermes.svg",
  },
  {
    id: "opencode",
    name: "OpenCode",
    runAlias: "opencode",
    icon: "/icons/opencode.svg",
  },
  {
    id: "openclaw",
    // OpenClaw's long-lived process is its gateway daemon, so the wrapped
    // command is multi-word.
    name: "OpenClaw",
    runAlias: "openclaw gateway run",
    icon: "/icons/openclaw.svg",
  },
] as const satisfies readonly CodingTool[];

export type CodingToolId = (typeof CODING_TOOLS)[number]["id"];

export interface InstallCommandContext {
  apiUrl: string;
  appUrl: string;
  apiKey: string;
}

const baseParams = ({ apiUrl, appUrl, apiKey }: InstallCommandContext) => {
  const params = [`key=${apiKey}`];
  // Off the production dashboard the script must be told which API host to
  // pin — the installed CLI defaults to the prod host.
  if (appUrl !== PROD_APP_URL) {
    params.push(`url=${encodeURIComponent(apiUrl)}`);
  }
  return params;
};

export const buildCliInstallCommand = (
  ctx: InstallCommandContext,
  options: { tool?: CodingToolId; agentIdentifier?: string } = {},
): string => {
  const params = baseParams(ctx);
  if (options.tool) {
    params.push(`tool=${encodeURIComponent(options.tool)}`);
  }
  if (options.agentIdentifier) {
    params.push(`agent=${encodeURIComponent(options.agentIdentifier)}`);
  }
  return `curl -fsSL "${ctx.apiUrl}/v1/install/cli?${params.join("&")}" | sh`;
};

export const buildRunCommand = (
  runAlias: string,
  agentIdentifier?: string,
): string =>
  agentIdentifier
    ? `onecli run --agent ${agentIdentifier} -- ${runAlias}`
    : `onecli run -- ${runAlias}`;
