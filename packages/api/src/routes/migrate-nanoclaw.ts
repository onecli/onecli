import { Hono } from "hono";
import { db } from "@onecli/db";
import { getSelfUrl } from "../providers";
import { appOrigin } from "../lib/public-origins";
import { markOnboardingCompleteByApiKey } from "../services/onboarding-service";
import { deviceAuthBlock } from "./shell-fragments";

const API_KEY_PATTERN = /^oc_[a-f0-9]{64}$/;
const URL_PATTERN = /^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?(\/[a-zA-Z0-9._/-]*)?$/;

export const migrateNanoclawRoutes = () => {
  const app = new Hono();

  // GET /nanoclaw
  app.get("/nanoclaw", async (c) => {
    const key = c.req.query("key") ?? null;
    const url = c.req.query("url") ?? null;

    if (key && !API_KEY_PATTERN.test(key)) {
      return c.json({ error: "Invalid API key format" }, 400);
    }
    if (url && !URL_PATTERN.test(url)) {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    let workspaceId: string | null = null;
    if (key) {
      const record = await db.apiKey.findUnique({
        where: { key },
        select: { workspaceId: true },
      });
      workspaceId = record?.workspaceId ?? null;

      // Running the script = leaving onboarding. Mark it the instant the curl is
      // fetched (not when the agent later connects), so migrating exits
      // onboarding mode even if the script errors out partway.
      await markOnboardingCompleteByApiKey(key).catch(() => {});
    }

    const onecliUrl = url ?? getSelfUrl();
    const script = buildScript(key, onecliUrl, appOrigin(), workspaceId);

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
  appUrl: string,
  workspaceId: string | null,
): string => {
  const parts: string[] = [
    "#!/bin/sh",
    "set -e",
    "",
    'echo ""',
    'echo "  ╔══════════════════════════════════════╗"',
    'echo "  ║      Migrate to OneCLI Cloud         ║"',
    'echo "  ╚══════════════════════════════════════╝"',
    'echo ""',
    "",
    `ONECLI_URL="${onecliUrl}"`,
    `DASHBOARD_URL="${appUrl}"`,
  ];

  if (apiKey) {
    parts.push(`ONECLI_API_KEY="${apiKey}"`);
    if (workspaceId) {
      parts.push(`ONECLI_WORKSPACE_ID="${workspaceId}"`);
    } else {
      parts.push('ONECLI_WORKSPACE_ID=""');
    }
  } else {
    parts.push(...deviceAuthBlock(onecliUrl));
  }

  parts.push(...migrationSteps());

  return parts.join("\n");
};

const migrationSteps = (): string[] => [
  "",
  "# ── Detect the current api-host before switching ──",
  'CONFIG_DIR="$HOME/.onecli"',
  'CONFIG_FILE="$CONFIG_DIR/config.json"',
  'CURRENT_HOST=""',
  "",
  'if [ -f "$CONFIG_FILE" ]; then',
  `  CURRENT_HOST=$(grep '"api-host"' "$CONFIG_FILE" | sed 's/.*: *"\\(.*\\)".*/\\1/')`,
  "fi",
  "",
  'if [ -n "$CURRENT_HOST" ] && [ "$CURRENT_HOST" != "$ONECLI_URL" ]; then',
  '  echo "  Current api-host: $CURRENT_HOST"',
  "fi",
  "",
  "# ── Update local OneCLI Docker (if running) ──",
  'COMPOSE_FILE="$HOME/.onecli/docker-compose.yml"',
  'if command -v docker >/dev/null 2>&1 && [ -f "$COMPOSE_FILE" ]; then',
  "  if docker compose -p onecli ps -q 2>/dev/null | grep -q .; then",
  '    echo "  Updating local OneCLI Docker image..."',
  '    PULL_ERR=$(docker compose -p onecli -f "$COMPOSE_FILE" pull 2>&1) || echo "  Warning: docker pull failed: $PULL_ERR"',
  '    echo "  Restarting local OneCLI..."',
  '    UP_ERR=$(docker compose -p onecli -f "$COMPOSE_FILE" up -d --wait 2>&1) || echo "  Warning: docker restart failed: $UP_ERR"',
  '    HEALTH_URL="${CURRENT_HOST:-http://127.0.0.1:10254}/v1/health"',
  "    for i in 1 2 3 4 5 6 7 8 9 10; do",
  "      sleep 2",
  '      if curl -fsSL "$HEALTH_URL" >/dev/null 2>&1; then',
  '        echo "  Local OneCLI is ready"',
  "        break",
  "      fi",
  "    done",
  "  fi",
  "fi",
  "",
  "# ── Ensure latest OneCLI CLI ──",
  'echo "  Updating OneCLI CLI..."',
  'CLI_ERR=$(curl -fsSL https://onecli.sh/cli/install 2>/dev/null | sh 2>&1) || echo "  Warning: CLI update failed: $CLI_ERR"',
  'export PATH="$HOME/.local/bin:$PATH"',
  "",
  "# ── Update CLI config ──",
  "",
  'mkdir -p "$CONFIG_DIR"',
  'printf \'{\n  "api-host": "%s"\n}\n\' "$ONECLI_URL" > "$CONFIG_FILE"',
  'echo "  Updated ~/.onecli/config.json"',
  "",
  "# ── Store API key ──",
  "if command -v onecli >/dev/null 2>&1; then",
  '  echo "$ONECLI_API_KEY" | onecli auth login >/dev/null 2>&1',
  "else",
  '  mkdir -p "$CONFIG_DIR/credentials"',
  '  printf \'%s\' "$ONECLI_API_KEY" > "$CONFIG_DIR/credentials/api-key"',
  '  chmod 600 "$CONFIG_DIR/credentials/api-key"',
  "fi",
  'echo "  API key stored"',
  "",
  "# ── Find all NanoClaw instances ──",
  'NANOCLAW_DIRS=""',
  "",
  "add_nc_dir() {",
  '  [ -d "$1" ] || return 0',
  '  case ":$NANOCLAW_DIRS:" in',
  '    *":$1:"*) return 0 ;;',
  "  esac",
  '  NANOCLAW_DIRS="${NANOCLAW_DIRS:+$NANOCLAW_DIRS:}$1"',
  "}",
  "",
  "# macOS: check all launchd plists mentioning nanoclaw",
  'if [ "$(uname -s)" = "Darwin" ]; then',
  '  for PLIST in "$HOME/Library/LaunchAgents/"*nanoclaw*; do',
  '    [ -f "$PLIST" ] || continue',
  '    DIR=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$PLIST" 2>/dev/null || true)',
  '    [ -n "$DIR" ] && add_nc_dir "$DIR"',
  "  done",
  "fi",
  "",
  "# Linux/WSL: check systemd units",
  "if command -v systemctl >/dev/null 2>&1; then",
  "  UNITS=$(systemctl --user list-unit-files 2>/dev/null | grep nanoclaw | awk '{ print $1 }')",
  "  for UNIT in $UNITS; do",
  '    DIR=$(systemctl --user show "$UNIT" -p WorkingDirectory 2>/dev/null | cut -d= -f2)',
  '    [ -n "$DIR" ] && add_nc_dir "$DIR"',
  "  done",
  "fi",
  "",
  "# Search common installation directories",
  'for D in "$HOME"/ClawAgents/nanoclaw* "$HOME"/nanoclaw* "$PWD"/nanoclaw*; do',
  '  [ -f "$D/.env" ] && add_nc_dir "$D"',
  "done",
  "",
  "# ── Update all NanoClaw instances ──",
  "",
  'if [ -n "$NANOCLAW_DIRS" ]; then',
  "",
  "  # Clear cached gateway CA (shared across all instances)",
  "  rm -f /tmp/onecli-gateway-ca.pem /tmp/onecli-combined-ca.pem",
  '  echo "  Cleared cached gateway CA"',
  "",
  '  SAVE_IFS="$IFS"',
  '  IFS=":"',
  "  for NC_DIR in $NANOCLAW_DIRS; do",
  '    IFS="$SAVE_IFS"',
  '    echo ""',
  '    echo "  Found NanoClaw at: $NC_DIR"',
  "",
  '    ENV_FILE="$NC_DIR/.env"',
  '    if [ -f "$ENV_FILE" ]; then',
  '      grep -v "^ONECLI_URL=" "$ENV_FILE" | grep -v "^ONECLI_API_KEY=" > "$ENV_FILE.tmp"',
  '      mv "$ENV_FILE.tmp" "$ENV_FILE"',
  "    fi",
  '    echo "ONECLI_URL=$ONECLI_URL" >> "$ENV_FILE"',
  '    echo "ONECLI_API_KEY=$ONECLI_API_KEY" >> "$ENV_FILE"',
  '    echo "  Updated NanoClaw .env"',
  "",
  "    # Sync .env to container env (containers read from data/env/env)",
  '    if [ -d "$NC_DIR/data/env" ]; then',
  '      cp "$ENV_FILE" "$NC_DIR/data/env/env"',
  '      echo "  Synced container env"',
  "    fi",
  "",
  "    # Restart NanoClaw service (launchd on macOS, systemd on Linux)",
  '    NC_BASENAME=$(basename "$NC_DIR")',
  "    RESTARTED=0",
  '    if [ "$(uname -s)" = "Darwin" ]; then',
  '      for PLIST in "$HOME/Library/LaunchAgents/"*nanoclaw*; do',
  '        [ -f "$PLIST" ] || continue',
  '        PLIST_DIR=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$PLIST" 2>/dev/null || true)',
  '        if [ "$PLIST_DIR" = "$NC_DIR" ]; then',
  '          LABEL=$(/usr/libexec/PlistBuddy -c "Print :Label" "$PLIST" 2>/dev/null || true)',
  '          if [ -n "$LABEL" ]; then',
  '            launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null \\',
  '              && echo "  Restarted service: $LABEL" \\',
  '              || echo "  Could not restart service: $LABEL"',
  "            RESTARTED=1",
  "          fi",
  "        fi",
  "      done",
  "    elif command -v systemctl >/dev/null 2>&1; then",
  "      UNITS=$(systemctl --user list-unit-files 2>/dev/null | grep nanoclaw | awk '{ print $1 }')",
  "      for UNIT in $UNITS; do",
  '        UNIT_DIR=$(systemctl --user show "$UNIT" -p WorkingDirectory 2>/dev/null | cut -d= -f2)',
  '        if [ "$UNIT_DIR" = "$NC_DIR" ]; then',
  '          systemctl --user restart "$UNIT" 2>/dev/null \\',
  '            && echo "  Restarted service: $UNIT" \\',
  '            || echo "  Could not restart service: $UNIT"',
  "          RESTARTED=1",
  "        fi",
  "      done",
  "    fi",
  '    if [ "$RESTARTED" = "0" ]; then',
  "      # Fallback: try Docker Compose if no system service found",
  "      if command -v docker >/dev/null 2>&1; then",
  '        for F in "$NC_DIR/docker-compose.yml" "$NC_DIR/compose.yml"; do',
  '          if [ -f "$F" ]; then',
  '            docker compose -f "$F" down 2>/dev/null || true',
  '            docker compose -f "$F" up -d 2>/dev/null \\',
  '              && echo "  Restarted NanoClaw containers" \\',
  '              || echo "  Could not restart. Run: cd $NC_DIR && docker compose up -d"',
  "            RESTARTED=1",
  "            break",
  "          fi",
  "        done",
  "      fi",
  "    fi",
  '    if [ "$RESTARTED" = "0" ]; then',
  '      echo "  Note: Could not find service to restart. Restart NanoClaw manually."',
  "    fi",
  "  done",
  '  IFS="$SAVE_IFS"',
  "else",
  '  echo ""',
  '  echo "  NanoClaw not found (skipped)."',
  '  echo "  If installed elsewhere, update your .env manually:"',
  '  echo "    ONECLI_URL=$ONECLI_URL"',
  '  echo "    ONECLI_API_KEY=$ONECLI_API_KEY"',
  "fi",
  "",
  "# ── Verify ──",
  'echo ""',
  "if command -v onecli >/dev/null 2>&1; then",
  "  STATUS=$(onecli auth status 2>&1)",
  `  EMAIL=$(echo "$STATUS" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4)`,
  '  if [ -n "$EMAIL" ]; then',
  '    echo "  Connected as: $EMAIL"',
  "  else",
  '    echo "  Run \\"onecli auth status\\" to verify."',
  "  fi",
  "fi",
  "",
  "# ── Stop local OneCLI Docker (if running) ──",
  "if docker compose -p onecli ps -q 2>/dev/null | grep -q .; then",
  '  echo ""',
  '  echo "  Local OneCLI Docker is still running."',
  '  echo "  To stop it: docker compose -p onecli -f ~/.onecli/docker-compose.yml down"',
  "fi",
  "",
  'DASH_PREFIX=""',
  'if [ -n "$ONECLI_WORKSPACE_ID" ]; then',
  '  DASH_PREFIX="/w/$ONECLI_WORKSPACE_ID"',
  "fi",
  "",
  'echo ""',
  'echo "  ╔══════════════════════════════════════╗"',
  'echo "  ║    Migrated to OneCLI Cloud!         ║"',
  'echo "  ╚══════════════════════════════════════╝"',
  'echo ""',
  'echo "  Dashboard: $DASHBOARD_URL$DASH_PREFIX"',
  'echo ""',
  'echo "  Reconnect your app integrations:"',
  'echo "  $DASHBOARD_URL$DASH_PREFIX/connections"',
  'echo ""',
  "",
  "# ── Notify OneCLI Cloud ──",
  'curl -fsSL -X POST "$ONECLI_URL/v1/onboarding/install-complete" \\',
  '  -H "X-API-Key: $ONECLI_API_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  '  -d \'{"type":"migrate"}\' >/dev/null 2>&1 || true',
];
