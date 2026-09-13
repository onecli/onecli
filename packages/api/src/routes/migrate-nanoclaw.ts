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

/**
 * The in-container secret extractor (plain Node, zero new dependencies).
 *
 * Runs INSIDE the user's own v1 `onecli` container via `docker exec -i … node -`,
 * because everything needed lives there already: the Postgres connection (the
 * app's own Prisma client + DATABASE_URL), the AES key (env or the key file the
 * entrypoint generates), and Node itself. Decryption happens on the user's
 * machine; plaintext leaves it only over HTTPS to the cloud API — the same
 * trust boundary as typing the secret into the dashboard.
 *
 * Tolerant of every v1 schema by design: `findMany()` with no select (columns
 * like `valueSource` appeared mid-v1), filtering in JS. Skips instead of
 * failing on rows it cannot carry (1Password-sourced, platform-owned, empty).
 * Idempotent: names already present in the destination workspace are skipped,
 * so re-running the script never duplicates. Exit 1 on any real failure so the
 * shell wrapper can abort the migration BEFORE any config is touched.
 *
 * Exported for tests (`node --check` validates the syntax).
 */
export const SECRET_EXTRACTOR_JS = String.raw`const { createDecipheriv } = require("node:crypto");
const { readFileSync, existsSync } = require("node:fs");

// Env reads use bracket notation deliberately: this string runs inside the
// USER'S v1 container, not this server — dot access would trip the
// hermetic-env drift guard, which catalogs this server's own env surface.
const env = process.env;
const CLOUD_URL = env["MIGRATE_CLOUD_URL"];
const CLOUD_KEY = env["MIGRATE_CLOUD_KEY"];
if (!CLOUD_URL || !CLOUD_KEY) {
  console.error("missing MIGRATE_CLOUD_URL / MIGRATE_CLOUD_KEY");
  process.exit(1);
}

// ── Encryption key: env first, then the file the docker entrypoint generates ──
const KEY_FILE = "/app/data/secret-encryption-key";
const keyB64 =
  env["SECRET_ENCRYPTION_KEY"] ||
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : null);
if (!keyB64) {
  console.error("no SECRET_ENCRYPTION_KEY found (env or " + KEY_FILE + ")");
  process.exit(1);
}
const key = Buffer.from(keyB64, "base64");

// v1 format (unchanged across all of v1): base64(iv):base64(tag):base64(ct), AES-256-GCM.
const decrypt = (stored) => {
  const [iv, tag, ct] = stored.split(":").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
};

// ── Prisma client: resolve the way the app would, across v1's pnpm layouts ──
const { createRequire } = require("node:module");
const resolvePrisma = () => {
  const roots = [
    "/app/node_modules/.pnpm/node_modules/x.js", // pnpm virtual store (v1 images)
    "/app/packages/db/node_modules/x.js",
    "/app/node_modules/x.js",
  ];
  for (const root of roots) {
    try {
      return createRequire(root)("@prisma/client");
    } catch {
      /* try the next layout */
    }
  }
  console.error("could not resolve @prisma/client inside the container");
  process.exit(1);
};

const main = async () => {
  const { PrismaClient } = resolvePrisma();
  const db = new PrismaClient();
  // No select: tolerant of every v1 schema (valueSource arrived mid-v1).
  const rows = await db.secret.findMany();
  await db.$disconnect();

  const headers = {
    Authorization: "Bearer " + CLOUD_KEY,
    "Content-Type": "application/json",
  };

  // Existing names in the destination: the idempotency guard (the API answers
  // 201 for duplicate names, so the pre-check is what makes re-runs safe).
  const listRes = await fetch(CLOUD_URL + "/v1/secrets", { headers });
  if (!listRes.ok) {
    console.error("cloud list failed: HTTP " + listRes.status);
    process.exit(1);
  }
  const have = new Set((await listRes.json()).map((s) => s.name));

  let imported = 0;
  let failed = 0;
  const skipped = [];
  for (const r of rows) {
    if (r.isPlatform) continue; // platform-owned, never the user's to migrate
    if (r.valueSource === "onepassword" || !r.encryptedValue) {
      skipped.push(r.name + " (1Password-sourced; re-add after migrating)");
      continue;
    }
    if (have.has(r.name)) {
      skipped.push(r.name + " (already exists in cloud)");
      continue;
    }
    have.add(r.name); // a same-name row later in the list (org scope) is a dup
    let value;
    try {
      value = decrypt(r.encryptedValue);
    } catch {
      skipped.push(r.name + " (could not decrypt)");
      continue;
    }
    // Null fields must be OMITTED: the cloud validator rejects explicit null.
    const body = { name: r.name, type: r.type, value, hostPattern: r.hostPattern };
    if (r.pathPattern) body.pathPattern = r.pathPattern;
    if (r.injectionConfig) body.injectionConfig = r.injectionConfig;
    const res = await fetch(CLOUD_URL + "/v1/secrets", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok) {
      imported++;
    } else {
      failed++;
      const err = await res.text().catch(() => "");
      // Names only — never a secret value.
      console.error("  failed: " + r.name + " (HTTP " + res.status + ") " + err.slice(0, 120));
    }
  }

  console.log("  Secrets migrated: " + imported);
  for (const s of skipped) console.log("  Skipped: " + s);
  if (failed > 0) {
    console.error("  " + failed + " secret(s) failed to import");
    process.exit(1);
  }
};

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});`;

/**
 * The data step: carry the v1 instance's secrets to cloud BEFORE any config is
 * touched, by running the extractor above inside the user's `onecli` container.
 *
 * Placement is the safety property: on any failure the script aborts while the
 * user is still fully on v1 — nothing reconfigured, NanoClaw untouched.
 * A machine with no local OneCLI container (NanoClaw-only installs, already-
 * migrated re-runs) skips the step and continues.
 *
 * The heredoc uses a quoted delimiter ('ONECLI_MIGRATE_EOF') so the shell
 * expands nothing inside the JS; the two values the extractor needs cross via
 * `docker exec -e`. `MIGRATE_CLOUD_URL` is the host-reachable API base — for a
 * local dev cloud, 127.0.0.1 would resolve to the v1 container itself, so
 * localhost hosts are rewritten to Docker's host alias when one is known.
 */
const secretMigrationStep = (): string[] => [
  "# ── Migrate local secrets to cloud (before any config changes) ──",
  'V1_CONTAINER=""',
  "if command -v docker >/dev/null 2>&1; then",
  "  # The official installs pin the container name; fall back to the image.",
  "  V1_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x \"onecli\" || true)",
  '  if [ -z "$V1_CONTAINER" ]; then',
  "    # Fallback: any container running the official image, whatever its tag.",
  "    V1_CONTAINER=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /^ghcr.io\\/onecli\\/onecli(:|$)/ { print $1; exit }' || true)",
  "  fi",
  "fi",
  "",
  'if [ -n "$V1_CONTAINER" ]; then',
  '  echo "  Found local OneCLI container: $V1_CONTAINER"',
  '  echo "  Migrating secrets to cloud..."',
  "",
  "  # From inside the v1 container, localhost is the container itself — use",
  "  # Docker's host alias for a cloud URL that points at this machine.",
  '  MIGRATE_URL="$ONECLI_URL"',
  '  case "$MIGRATE_URL" in',
  "    http://127.0.0.1*|http://localhost*)",
  `      MIGRATE_URL=$(echo "$MIGRATE_URL" | sed 's|//127.0.0.1|//host.docker.internal|; s|//localhost|//host.docker.internal|')`,
  "      ;;",
  "  esac",
  "",
  '  if docker exec -i -e MIGRATE_CLOUD_URL="$MIGRATE_URL" -e MIGRATE_CLOUD_KEY="$ONECLI_API_KEY" "$V1_CONTAINER" node - <<\'ONECLI_MIGRATE_EOF\'',
  SECRET_EXTRACTOR_JS,
  "ONECLI_MIGRATE_EOF",
  "  then",
  '    echo "  Secret migration complete"',
  "  else",
  '    echo ""',
  '    echo "  Secret migration failed — nothing has been changed."',
  '    echo "  Your local OneCLI and NanoClaw are untouched and still working."',
  '    echo "  Fix the issue above and re-run this script."',
  "    exit 1",
  "  fi",
  "else",
  '  echo "  No local OneCLI container found — skipping secret migration."',
  "fi",
  "",
];

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
  ...secretMigrationStep(),
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
  'echo "  Migrated LLM keys attach to your agents automatically."',
  'echo "  Grant other migrated secrets to agents here:"',
  'echo "  $DASHBOARD_URL$DASH_PREFIX/agents"',
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
