#!/bin/sh
set -e

PRISMA="node /app/packages/db/node_modules/prisma/build/index.js"
SCHEMA="--schema /app/packages/db/prisma/schema.prisma"

# Run database migrations
echo "Running database migrations..."
if ! $PRISMA migrate deploy $SCHEMA 2>&1; then
  echo "migrate deploy failed — bootstrapping baseline migration..."
  $PRISMA migrate resolve --applied 0_init $SCHEMA
  $PRISMA migrate deploy $SCHEMA
fi

# Auto-generate SECRET_ENCRYPTION_KEY for OSS if not provided.
# Persisted to /app/data/ so encrypted secrets survive container restarts.
# Cloud edition uses AWS KMS instead (key provided via env var / Secrets Manager).
if [ "$NEXT_PUBLIC_EDITION" != "cloud" ] && [ -z "$SECRET_ENCRYPTION_KEY" ]; then
  SECRET_KEY_FILE="/app/data/secret-encryption-key"
  if [ ! -f "$SECRET_KEY_FILE" ] || [ ! -s "$SECRET_KEY_FILE" ]; then
    echo "Generating secret encryption key..."
    head -c 32 /dev/urandom | base64 > "$SECRET_KEY_FILE"
    chmod 600 "$SECRET_KEY_FILE"
  fi
  export SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY=$(cat "$SECRET_KEY_FILE")
fi

# Write runtime config for Next.js (auth mode is determined at container start,
# not at build time, so the same image works for local and OAuth modes).
if [ "$NEXT_PUBLIC_EDITION" = "cloud" ]; then
  AUTH_MODE="cloud"
elif [ -n "$NEXTAUTH_SECRET" ]; then
  AUTH_MODE="oauth"
else
  AUTH_MODE="local"
fi
export AUTH_MODE
OAUTH_CONFIGURED="false"
if [ "$AUTH_MODE" = "cloud" ] || [ -n "$GOOGLE_CLIENT_ID" ]; then
  OAUTH_CONFIGURED="true"
fi
printf '{"authMode":"%s","oauthConfigured":%s}\n' "$AUTH_MODE" "$OAUTH_CONFIGURED" > /app/data/runtime-config.json

# Anonymous telemetry — install/update events only.
# Disable: DO_NOT_TRACK=1 or Settings → General. Docs: https://onecli.sh/docs/reference/telemetry
ONECLI_VERSION=$(node -p "require('./apps/web/package.json').version" 2>/dev/null || echo "unknown")
VERSION_FILE="/app/data/.onecli-version"
PREF_FILE="/app/data/telemetry-preference"
PREV_VERSION=$(cat "$VERSION_FILE" 2>/dev/null || echo "")

send_telemetry() {
  UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || od -x /dev/urandom | head -1 | awk '{print $2$3"-"$4"-"$5"-"$6"-"$7$8$9}')
  PROPS="\"version\":\"$ONECLI_VERSION\",\"edition\":\"${NEXT_PUBLIC_EDITION:-oss}\",\"auth_mode\":\"$AUTH_MODE\",\"arch\":\"$(uname -m)\""
  [ -n "$2" ] && PROPS="$PROPS,\"old_version\":\"$2\""
  curl -sf --max-time 5 -X POST https://t.1cli.sh/capture/ \
    -H 'Content-Type: application/json' \
    -d "{\"api_key\":\"phc_lXPPe71vyF7OWTxnMBhVPIQtdRLkvpZQ9ve7NhANxLN\",\"event\":\"$1\",\"distinct_id\":\"$UUID\",\"properties\":{$PROPS}}" \
    > /dev/null 2>&1 &
  echo "Telemetry: $1 (anonymous). Disable: DO_NOT_TRACK=1"
}

echo "$ONECLI_VERSION" > "$VERSION_FILE"
if [ "${DO_NOT_TRACK:-}" != "1" ] && { [ ! -f "$PREF_FILE" ] || [ "$(cat "$PREF_FILE")" != "off" ]; }; then
  if [ -z "$PREV_VERSION" ]; then
    send_telemetry "install_complete"
  elif [ "$PREV_VERSION" != "$ONECLI_VERSION" ]; then
    send_telemetry "update_complete" "$PREV_VERSION"
  fi
fi

# Start gateway in background
echo "Starting gateway on port ${GATEWAY_PORT:-10255}..."
onecli-gateway --port "${GATEWAY_PORT:-10255}" --data-dir /app/data &
GATEWAY_PID=$!

# Graceful shutdown: stop both processes on SIGTERM
trap "kill $GATEWAY_PID 2>/dev/null; wait $GATEWAY_PID 2>/dev/null; exit 0" TERM INT

# Start Next.js (foreground)
exec node apps/web/server.js
