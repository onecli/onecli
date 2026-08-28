import { Hono } from "hono";
import { getSelfUrl } from "../providers";
import { markOnboardingCompleteByApiKey } from "../services/onboarding-service";
import { IDENTIFIER_REGEX } from "../validations/agent";
import { deviceAuthBlock } from "./shell-fragments";

const API_KEY_PATTERN = /^oc_[a-f0-9]{64}$/;
const URL_PATTERN = /^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?(\/[a-zA-Z0-9._/-]*)?$/;

// Coding-tool frameworks the script can suggest an alias for. Distinct from
// the dashboard agent identity: `tool=` names the framework, `agent=` names
// the agent (see the legacy note in the handler). Mirrors the CLI's
// `supportedAgents` table (cmd/onecli/run.go) — keep in lockstep with
// CODING_TOOLS in the web's lib/install-command.ts.
const VALID_TOOLS = [
  "claude-code",
  "cursor",
  "codex",
  "hermes",
  "opencode",
  "openclaw",
];

// Accepted but never offered: ids old dialogs / the onboarding survey still
// send. github-copilot predates the CLI-table alignment (the CLI has no
// dedicated copilot integration; `onecli run -- copilot` still works
// generically). Copied commands must never start failing.
const LEGACY_TOOLS = ["github-copilot"];

// `run` is the wrapped command when it differs from the alias name —
// OpenClaw's long-lived process is `openclaw gateway run`.
const TOOL_ALIASES: Record<
  string,
  { alias: string; label: string; run?: string }
> = {
  "claude-code": { alias: "claude", label: "Claude Code" },
  cursor: { alias: "cursor", label: "Cursor" },
  codex: { alias: "codex", label: "Codex" },
  hermes: { alias: "hermes", label: "Hermes" },
  opencode: { alias: "opencode", label: "OpenCode" },
  openclaw: {
    alias: "openclaw",
    label: "OpenClaw",
    run: "openclaw gateway run",
  },
  "github-copilot": { alias: "copilot", label: "GitHub Copilot" },
};

export const installRoutes = () => {
  const app = new Hono();

  // GET /cli
  app.get("/cli", async (c) => {
    const key = c.req.query("key") ?? null;
    const url = c.req.query("url") ?? null;
    let tool = c.req.query("tool") ?? null;
    let agent = c.req.query("agent") ?? null;

    // Legacy contract: before `tool=` existed, `agent=` carried the coding-tool
    // framework id. New URLs always send `tool=`, so when it's absent and
    // `agent=` names a known tool, treat it as the tool — old copied commands
    // keep working forever. When `tool=` is present, `agent=` is always a
    // dashboard agent identifier (even one that happens to spell a tool name).
    const knownTool = (id: string) =>
      VALID_TOOLS.includes(id) || LEGACY_TOOLS.includes(id);
    if (!tool && agent && knownTool(agent)) {
      tool = agent;
      agent = null;
    }

    if (key && !API_KEY_PATTERN.test(key)) {
      return c.json({ error: "Invalid API key format" }, 400);
    }
    if (url && !URL_PATTERN.test(url)) {
      return c.json({ error: "Invalid URL format" }, 400);
    }
    if (tool && !knownTool(tool)) {
      return c.json({ error: "Invalid tool identifier" }, 400);
    }
    if (agent && !IDENTIFIER_REGEX.test(agent)) {
      return c.json({ error: "Invalid agent identifier" }, 400);
    }

    // Running the script = leaving onboarding. Mark it the instant the curl is
    // fetched (not when the agent later connects), so any agent exits onboarding
    // mode even if the install script errors out partway.
    if (key) await markOnboardingCompleteByApiKey(key).catch(() => {});

    const onecliUrl = url ?? getSelfUrl();
    const script = buildScript(key, onecliUrl, tool, agent);

    return new Response(script, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  });

  return app;
};

const buildScript = (
  apiKey: string | null,
  onecliUrl: string,
  tool: string | null,
  agent: string | null,
): string => {
  const parts: string[] = [
    "#!/bin/sh",
    "set -e",
    "",
    'echo ""',
    'echo "  ╔════════════════════════════════════╗"',
    'echo "  ║         OneCLI CLI Setup           ║"',
    'echo "  ╚════════════════════════════════════╝"',
    'echo ""',
    "",
    // ONECLI_API_HOST, not ONECLI_URL: the old name collided with the
    // dashboard-URL meaning elsewhere; this one says what it is — the api
    // host the CLI talks to. Regenerated per fetch, so the rename is safe.
    `ONECLI_API_HOST="${onecliUrl}"`,
  ];

  if (apiKey) {
    parts.push(`ONECLI_API_KEY="${apiKey}"`);
  } else {
    parts.push(...deviceAuthBlock(onecliUrl));
  }

  if (agent) {
    parts.push(`AGENT="${agent}"`);
  }

  parts.push(
    "",
    "# ── Install OneCLI CLI ──",
    'echo "  Installing OneCLI CLI..."',
    "curl -fsSL https://onecli.sh/cli/install 2>/dev/null | sh >/dev/null 2>&1",
    'export PATH="$HOME/.local/bin:$PATH"',
    "",
    "# ── Configure and authenticate CLI ──",
    'onecli config set api-host "$ONECLI_API_HOST" >/dev/null 2>&1 || true',
    'onecli auth login --api-key "$ONECLI_API_KEY" >/dev/null 2>&1 || true',
  );

  if (agent) {
    parts.push(
      "",
      "# ── Pin this machine to the chosen agent ──",
      "# Loud on failure: an older CLI has no `agent` config key, and a silent",
      "# skip would leave this machine unpinned — which a workspace without a",
      "# legacy default agent refuses at run time.",
      'if onecli config set agent "$AGENT" >/dev/null 2>&1; then',
      '  echo "  This machine is pinned to agent \\"$AGENT\\"."',
      "else",
      '  echo ""',
      '  echo "  ⚠ This CLI version cannot pin an agent. Update it, or launch with:"',
      '  echo ""',
      '  echo "      onecli run --agent $AGENT -- <command>"',
      "fi",
    );
  }

  parts.push(
    "",
    'echo ""',
    'echo "  ╔════════════════════════════════════╗"',
    'echo "  ║      ✓ OneCLI CLI is ready!        ║"',
    'echo "  ╚════════════════════════════════════╝"',
    'echo ""',
    'echo "  You can now use the OneCLI CLI:"',
    'echo ""',
    'echo "    onecli --help"',
    'echo ""',
  );

  if (tool) {
    const aliasInfo = TOOL_ALIASES[tool];
    if (aliasInfo) {
      const run = aliasInfo.run ?? aliasInfo.alias;
      parts.push(
        "# ── Shell alias suggestion ──",
        'SHELL_RC_NAME=".bashrc"',
        'if [ -n "$ZSH_VERSION" ] || [ "$(basename "$SHELL" 2>/dev/null)" = "zsh" ]; then',
        '  SHELL_RC_NAME=".zshrc"',
        "fi",
        "",
        'echo "  ─────────────────────────────────────"',
        'echo ""',
        `echo "  💡 Add a shortcut for ${aliasInfo.label}:"`,
        'echo ""',
        `echo "    echo 'alias ${aliasInfo.alias}=\\"onecli run -- ${run}\\"' >> ~/$SHELL_RC_NAME"`,
        'echo ""',
        'echo "  Then reload your shell:"',
        'echo ""',
        'echo "    source ~/$SHELL_RC_NAME"',
        'echo ""',
        `echo "  After that, just run: ${aliasInfo.alias}"`,
        'echo ""',
        'echo ""',
      );
    }
  }

  parts.push(
    "",
    "# ── Notify OneCLI Cloud ──",
    'curl -fsSL -X POST "$ONECLI_API_HOST/v1/onboarding/install-complete" \\',
    '  -H "X-API-Key: $ONECLI_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"type":"cli-install"}\' >/dev/null 2>&1 || true',
  );

  return parts.join("\n");
};
