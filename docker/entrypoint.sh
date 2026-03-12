#!/bin/sh
set -e

PRISMA="node /app/packages/db/node_modules/prisma/build/index.js"
SCHEMA="--schema /app/packages/db/prisma/schema.prisma"

# Generate proxy–API shared secret if not already present.
# The proxy reads this file to authenticate requests to /api/proxy/* endpoints.
# In cloud mode, PROXY_SECRET env var is used instead (from Secrets Manager).
if [ -z "$PROXY_SECRET" ]; then
  PROXY_SECRET_FILE="${PROXY_SECRET_FILE:-/app/data/proxy-secret}"
  if [ ! -f "$PROXY_SECRET_FILE" ] || [ ! -s "$PROXY_SECRET_FILE" ]; then
    echo "Generating proxy–API shared secret..."
    mkdir -p "$(dirname "$PROXY_SECRET_FILE")"
    head -c 32 /dev/urandom | xxd -p -c 64 > "$PROXY_SECRET_FILE"
    chmod 600 "$PROXY_SECRET_FILE"
  fi
fi

if [ -n "$DATABASE_URL" ]; then
  echo "External database detected, running Prisma migrations..."
  if ! $PRISMA migrate deploy $SCHEMA 2>&1; then
    echo "migrate deploy failed — bootstrapping baseline migration..."
    $PRISMA migrate resolve --applied 0_init $SCHEMA
    $PRISMA migrate deploy $SCHEMA
  fi
else
  echo "No DATABASE_URL set, initializing embedded PGlite database..."
  node /app/packages/db/scripts/init-dev-db.ts
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
OAUTH_CONFIGURED="false"
if [ "$AUTH_MODE" = "cloud" ] || [ -n "$GOOGLE_CLIENT_ID" ]; then
  OAUTH_CONFIGURED="true"
fi
printf '{"authMode":"%s","oauthConfigured":%s}\n' "$AUTH_MODE" "$OAUTH_CONFIGURED" > /app/data/runtime-config.json

# Start proxy in background
echo "Starting proxy on port ${PROXY_PORT:-10255}..."
onecli-proxy --port "${PROXY_PORT:-10255}" --data-dir /app/data &
PROXY_PID=$!

# Graceful shutdown: stop both processes on SIGTERM
trap "kill $PROXY_PID 2>/dev/null; wait $PROXY_PID 2>/dev/null; exit 0" TERM INT

# Start Next.js (foreground)
exec node apps/web/server.js
