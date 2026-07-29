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

# Both services run as background children so this shell stays alive to
# supervise them. It deliberately does NOT `exec` the web server: doing so
# replaces the shell, which discards the trap below (graceful shutdown then
# never runs) and leaves the gateway as an inherited child of Node — which reaps
# only what it spawned itself, so the gateway becomes a permanent <defunct> when
# it exits. tini is PID 1 above this (see docker/Dockerfile) and reaps anything
# that is genuinely orphaned; this shell owns these two.

echo "Starting gateway on port ${GATEWAY_PORT:-10255}..."
onecli-gateway --port "${GATEWAY_PORT:-10255}" --data-dir /app/data &
GATEWAY_PID=$!

echo "Starting web server on port ${PORT:-10254}..."
node apps/web/server.js &
WEB_PID=$!

# Graceful shutdown: stop both children, then reap them so neither is left
# behind. Clearing the trap first keeps a second signal from re-entering while
# the teardown is still running. A child that ignored SIGTERM would keep these
# waits blocked, which is bounded by the runtime's own stop timeout (it SIGKILLs
# the container), and tini reaps whatever is left when this shell goes.
shutdown() {
  trap '' TERM INT
  echo "Shutting down..."
  kill "$WEB_PID" "$GATEWAY_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Wait for either child to exit by polling liveness rather than with `wait -n`.
# `wait -n` looks like the right tool and is not: it only reports children that
# exit *after* it is called, so a service that dies during startup — the common
# case, on a bad config or an unreachable database — is missed entirely and the
# container sits there half-running. Measured directly: with one child already
# dead, `wait -n` blocked for 27s until the *other* child exited. Polling asks
# the question that actually matters, "are both still alive?", and a `sleep` is
# interruptible so the trap above still fires immediately.
while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$GATEWAY_PID" 2>/dev/null; do
  sleep 1
done

if kill -0 "$WEB_PID" 2>/dev/null; then
  # The web server is still up, so the gateway is what exited. Take the whole
  # container down rather than serve without a proxy.
  echo "Gateway exited unexpectedly — stopping the container" >&2
  RC=1
else
  # The web server exited: carry its status out as the container's, the way
  # `exec node` used to. `wait` on an already-reaped child still reports the
  # real code here.
  RC=0
  wait "$WEB_PID" 2>/dev/null || RC=$?
  echo "Web server exited (code ${RC}) — stopping the container" >&2
fi

kill "$WEB_PID" "$GATEWAY_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$RC"
