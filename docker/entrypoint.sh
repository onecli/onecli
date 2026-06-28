#!/bin/sh
set -e

# Entrypoint for the all-in-one image (docker/Dockerfile): runs the gateway and
# the Next.js web server together in one container. The hosted cloud edition
# deploys its services as separate images and never uses this script — so the
# auth mode here is only ever "local" or "oauth", never "cloud".

PRISMA="node /app/packages/db/node_modules/prisma/build/index.js"
SCHEMA="--schema /app/packages/db/prisma/schema.prisma"

# Run database migrations
echo "Running database migrations..."
if ! $PRISMA migrate deploy $SCHEMA 2>&1; then
  echo "migrate deploy failed — bootstrapping baseline migration..."
  $PRISMA migrate resolve --applied 0_init $SCHEMA
  $PRISMA migrate deploy $SCHEMA
fi

# Auto-generate SECRET_ENCRYPTION_KEY if not provided.
# Persisted to /app/data/ so encrypted secrets survive container restarts.
if [ -z "$SECRET_ENCRYPTION_KEY" ]; then
  SECRET_KEY_FILE="/app/data/secret-encryption-key"
  if [ ! -f "$SECRET_KEY_FILE" ] || [ ! -s "$SECRET_KEY_FILE" ]; then
    echo "Generating secret encryption key..."
    head -c 32 /dev/urandom | base64 > "$SECRET_KEY_FILE"
    chmod 600 "$SECRET_KEY_FILE"
  fi
  export SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY=$(cat "$SECRET_KEY_FILE")
fi

# Auto-generate GATEWAY_INTERNAL_SECRET if not provided. It only authenticates
# the gateway -> Node API call inside THIS container, so unlike the encryption
# key it needs no persistence — an ephemeral per-start value is fine (nothing
# stored depends on it). Without it the 1Password integration fails closed.
if [ -z "$GATEWAY_INTERNAL_SECRET" ]; then
  echo "Generating gateway internal secret..."
  GATEWAY_INTERNAL_SECRET=$(head -c 32 /dev/urandom | base64)
  export GATEWAY_INTERNAL_SECRET
fi

# Write runtime config for Next.js (auth mode is determined at container start,
# not at build time, so the same image works for local and OAuth modes).
if [ -n "$NEXTAUTH_SECRET" ]; then
  AUTH_MODE="oauth"
else
  AUTH_MODE="local"
fi
export AUTH_MODE
OAUTH_CONFIGURED="false"
if [ -n "$GOOGLE_CLIENT_ID" ]; then
  OAUTH_CONFIGURED="true"
fi
printf '{"authMode":"%s","oauthConfigured":%s}\n' "$AUTH_MODE" "$OAUTH_CONFIGURED" > /app/data/runtime-config.json

# Start gateway in background
echo "Starting gateway on port ${GATEWAY_PORT:-10255}..."
onecli-gateway --port "${GATEWAY_PORT:-10255}" --data-dir /app/data &
GATEWAY_PID=$!

# Graceful shutdown: stop both processes on SIGTERM
trap "kill $GATEWAY_PID 2>/dev/null; wait $GATEWAY_PID 2>/dev/null; exit 0" TERM INT

# Start Next.js (foreground)
exec node apps/web/server.js
