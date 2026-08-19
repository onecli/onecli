#!/bin/sh

# OneCLI - Open-Source Credential Vault for AI Agents
# Source: https://github.com/onecli/onecli
# License: See repository for license details
#
# Usage: curl -fsSL https://onecli.sh/install | sh
#
# Custom bind host:
#   export ONECLI_BIND_HOST=192.168.1.50
#   curl -fsSL https://onecli.sh/install | sh
#
# Custom PostgreSQL port (if 5432 is already in use):
#   export POSTGRES_PORT=5433
#   curl -fsSL https://onecli.sh/install | sh
#
# Custom app/gateway/api ports (e.g. for multi-user hosts):
#   export ONECLI_APP_PORT=11254
#   export ONECLI_GATEWAY_PORT=11255
#   export ONECLI_API_PORT=11256
#   curl -fsSL https://onecli.sh/install | sh
#
# Pin a specific version:
#   export ONECLI_VERSION=1.2.0
#   curl -fsSL https://onecli.sh/install | sh
#
# Hosted agents run by default (the runner service). Install without them:
#   export COMPOSE_PROFILES=
#   curl -fsSL https://onecli.sh/install | sh
# (or edit the COMPOSE_PROFILES line in ~/.onecli/.env later — empty disables.)
#
# This script checks for Docker, downloads the docker-compose.yml matching the
# requested version, and starts OneCLI (dashboard + API + gateway + PostgreSQL
# + the hosted-agents runner) on ports 10254/10255/10256 by default.

INSTALL_DIR="$HOME/.onecli"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"
# v2 split the all-in-one container into web + gateway + api services.
# Installs pinned to a pre-2.0 version keep receiving the compose that matches
# those images (docker-compose.legacy.yml, frozen alongside them).
COMPOSE_URL_NEW="https://raw.githubusercontent.com/onecli/onecli/main/docker/docker-compose.yml"
COMPOSE_URL_LEGACY="https://raw.githubusercontent.com/onecli/onecli/main/docker/docker-compose.legacy.yml"
PROJECT_NAME="onecli"

# Which compose file serves this version: a numeric major below 2 gets the
# legacy all-in-one stack; everything else (2+, "latest", unset, non-numeric)
# gets the current split stack. Handles "1", "1.45", "1.45.0", "v1.44.2".
compose_url_for_version() {
  v="${1#v}"
  major="${v%%[!0-9]*}"
  if [ -n "$major" ] && [ "$major" -lt 2 ]; then
    echo "$COMPOSE_URL_LEGACY"
  else
    echo "$COMPOSE_URL_NEW"
  fi
}

# Detect the correct bind host for Docker port bindings.
# Never 0.0.0.0 — that would expose services to the network.
detect_bind_host() {
  # 1. Explicit env var — user knows best
  if [ -n "$ONECLI_BIND_HOST" ]; then
    echo "$ONECLI_BIND_HOST"
    return
  fi

  # 2. macOS — Docker Desktop, loopback works
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "127.0.0.1"
    return
  fi

  # 3. WSL — same VM routing as macOS (check /proc, not env vars)
  if [ -f /proc/sys/fs/binfmt_misc/WSLInterop ]; then
    echo "127.0.0.1"
    return
  fi

  # 4. Bare-metal Linux — bind to docker0 bridge IP
  if command -v ip >/dev/null 2>&1; then
    DOCKER0_IP=$(ip -4 addr show docker0 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]; exit}')
    if [ -n "$DOCKER0_IP" ]; then
      echo "$DOCKER0_IP"
      return
    fi
  fi

  # 5. Cannot determine safely
  echo ""
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    false
  fi
}

# Idempotently ensure a secret exists in $ENV_FILE: keep an existing line,
# otherwise append $2 (or a fresh random value).
ensure_env_secret() {
  if [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE"; then
    return
  fi
  _val="$2"
  if [ -z "$_val" ]; then
    _val=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  fi
  printf '%s=%s\n' "$1" "$_val" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Idempotently ensure a plain (non-secret) setting exists in $ENV_FILE.
ensure_env_value() {
  if [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE"; then
    return
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# The runner's credential (hosted agents): a "rnr_"-prefixed hex token, the
# same shape the API mints. Both the api and runner services read it, which is
# what makes runner registration zero-touch.
generate_runner_token() {
  printf 'rnr_%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

generate_channel_adapter_token() {
  printf 'cha_%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

# The group that owns the docker socket, which the (unprivileged) runner needs
# to spawn sandboxes.
#
# Read from INSIDE a container, not from the host filesystem: on Docker Desktop
# the host sees a proxy socket whose GID (1 on macOS) has nothing to do with the
# 0 that containers see, so a host-side `stat` produces a group that grants
# nothing and the runner dies with EACCES. On Linux both views agree — this
# just also happens to be the correct one everywhere.
detect_docker_gid() {
  _gid=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    alpine:3.21 stat -c '%g' /var/run/docker.sock 2>/dev/null | tr -d '\r\n')
  case "$_gid" in
    '' | *[!0-9]*) printf '0' ;;
    *) printf '%s' "$_gid" ;;
  esac
}

# Pre-2.0 all-in-one images auto-generated the encryption key inside the
# app-data volume; the split stack requires it as an env var. Carry it over so
# an upgraded install keeps decrypting its existing secrets.
legacy_volume_secret() {
  if ! docker volume inspect "${PROJECT_NAME}_app-data" >/dev/null 2>&1; then
    return
  fi
  docker run --rm -v "${PROJECT_NAME}_app-data:/data:ro" alpine:3.21 \
    cat /data/secret-encryption-key 2>/dev/null | tr -d '\r\n'
}

main() {
  echo ""
  echo "  OneCLI: The agent harness built for teams."
  echo ""

  # ── Prerequisites ──

  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is not installed." >&2
    echo "" >&2
    echo "Install Docker first: https://docs.docker.com/get-docker/" >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running." >&2
    echo "Please start Docker and try again." >&2
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Error: Docker Compose is not available." >&2
    echo "Please install Docker Compose: https://docs.docker.com/compose/install/" >&2
    exit 1
  fi

  # ── Detect bind host ──

  ONECLI_BIND_HOST=$(detect_bind_host)
  if [ -z "$ONECLI_BIND_HOST" ]; then
    echo "Error: Could not safely determine a bind address for OneCLI." >&2
    echo "" >&2
    echo "Please set ONECLI_BIND_HOST and try again:" >&2
    echo "  export ONECLI_BIND_HOST=<your-ip>" >&2
    echo "  curl -fsSL https://onecli.sh/install | sh" >&2
    exit 1
  fi
  export ONECLI_BIND_HOST
  echo "  Bind host: $ONECLI_BIND_HOST"

  # ── Resolve version → compose flavor ──

  ONECLI_VERSION="${ONECLI_VERSION:-latest}"
  export ONECLI_VERSION
  echo "  Version:   $ONECLI_VERSION"

  COMPOSE_URL=$(compose_url_for_version "$ONECLI_VERSION")
  if [ "$COMPOSE_URL" = "$COMPOSE_URL_LEGACY" ]; then
    STACK="legacy"
    echo "  Stack:     pre-2.0 all-in-one (legacy compose)"
  else
    STACK="split"
  fi

  # ── Download docker-compose.yml ──

  if ! mkdir -p "$INSTALL_DIR"; then
    echo "Error: Failed to create $INSTALL_DIR" >&2
    exit 1
  fi
  echo "  Downloading docker-compose.yml..."
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"; then
      echo "Error: Failed to download docker-compose.yml from $COMPOSE_URL" >&2
      exit 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -qO "$COMPOSE_FILE" "$COMPOSE_URL"; then
      echo "Error: Failed to download docker-compose.yml from $COMPOSE_URL" >&2
      exit 1
    fi
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi

  # ── Required secrets (split stack) ──
  # Must exist before ANY compose command touches the file — it refuses to
  # interpolate without them. Existing values are never overwritten.

  if [ "$STACK" = "split" ]; then
    if [ -f "$ENV_FILE" ] && grep -q "^SECRET_ENCRYPTION_KEY=" "$ENV_FILE"; then
      : # already provisioned — don't probe the legacy volume
    else
      ensure_env_secret SECRET_ENCRYPTION_KEY "$(legacy_volume_secret)"
    fi
    ensure_env_secret GATEWAY_INTERNAL_SECRET ""
    # Signs session cookies. Generated here so a fresh install can reach its
    # signup screen, and idempotent so an upgrade from a release that had no
    # logins provisions one without the operator having to know it exists.
    ensure_env_secret BETTER_AUTH_SECRET ""
    # Hosted agents (opt-in): provisioned up front so enabling the runner is a
    # one-line change rather than a secret-generation exercise. Provisioning
    # them does NOT start a runner — that needs COMPOSE_PROFILES=runner.
    ensure_env_secret RUNNER_TOKEN "$(generate_runner_token)"
    # Channels (opt-in, same posture): the Slack adapter's anchor. Provisioned
    # up front; starting the adapter needs COMPOSE_PROFILES=channel-adapter.
    ensure_env_secret CHANNEL_ADAPTER_TOKEN "$(generate_channel_adapter_token)"
    ensure_env_value DOCKER_GID "$(detect_docker_gid)"
    # Hosted agents ON by default — they are what a fresh install is for.
    # `${COMPOSE_PROFILES-runner}`: an exported empty value opts out; an
    # existing line in the env file is the operator's choice and stays.
    ensure_env_value COMPOSE_PROFILES "${COMPOSE_PROFILES-runner}"
  fi

  # ── Stop existing services ──
  # Label-gated so containers from a previous stack shape are seen too, and
  # --remove-orphans so upgrading past the all-in-one actually retires its
  # container (it is not a service in the new file).

  if docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null | grep -q .; then
    echo "  Stopping existing OneCLI services..."
    if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --remove-orphans; then
      echo "Error: Failed to stop existing OneCLI services." >&2
      exit 1
    fi
  fi

  # ── Check for port conflicts ──

  PG_PORT="${POSTGRES_PORT:-5432}"
  if port_in_use "$PG_PORT"; then
    echo "Error: Port $PG_PORT is already in use (probably a local PostgreSQL)." >&2
    echo "" >&2
    echo "Pick a free port for OneCLI's database:" >&2
    echo "  export POSTGRES_PORT=5433" >&2
    echo "  curl -fsSL https://onecli.sh/install | sh" >&2
    exit 1
  fi

  if [ "$STACK" = "split" ]; then
    for pair in "ONECLI_APP_PORT:${ONECLI_APP_PORT:-10254}" "ONECLI_GATEWAY_PORT:${ONECLI_GATEWAY_PORT:-10255}" "ONECLI_API_PORT:${ONECLI_API_PORT:-10256}"; do
      var="${pair%%:*}"
      port="${pair#*:}"
      if port_in_use "$port"; then
        echo "Error: Port $port is already in use." >&2
        echo "" >&2
        echo "Pick a free port:" >&2
        echo "  export $var=<free-port>" >&2
        echo "  curl -fsSL https://onecli.sh/install | sh" >&2
        exit 1
      fi
    done
  fi

  # ── Pull and start ──

  echo "  Pulling latest images..."
  if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" pull; then
    echo "Error: Failed to pull OneCLI images. Check your network connection." >&2
    exit 1
  fi

  echo "  Starting OneCLI..."
  if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait; then
    echo "" >&2
    echo "Error: Failed to start OneCLI." >&2
    echo "  A failed database migration is the most common cause. Inspect it with:" >&2
    echo "    docker compose -p $PROJECT_NAME -f $COMPOSE_FILE logs migrations" >&2
    echo "  Then the api itself:" >&2
    echo "    docker compose -p $PROJECT_NAME -f $COMPOSE_FILE logs api" >&2
    echo "  Note: the stack needs Docker Compose >= 2.19." >&2
    exit 1
  fi

  # ── Success ──

  echo ""
  echo "  OneCLI is running!"
  echo "  ONECLI_URL:  http://$ONECLI_BIND_HOST:${ONECLI_APP_PORT:-10254}"
  echo ""
  echo "  Dashboard:  http://$ONECLI_BIND_HOST:${ONECLI_APP_PORT:-10254}"
  echo "  Gateway:    http://$ONECLI_BIND_HOST:${ONECLI_GATEWAY_PORT:-10255}"
  if [ "$STACK" = "split" ]; then
    echo "  API:        http://$ONECLI_BIND_HOST:${ONECLI_API_PORT:-10256}"
    if grep "^COMPOSE_PROFILES=" "$ENV_FILE" | tail -1 | grep -q runner; then
      echo "  Agents:     hosted agents are ON (the runner mounts the Docker socket to start sandboxes;"
      echo "              disable with COMPOSE_PROFILES= in $ENV_FILE)"
    else
      echo "  Agents:     off (set COMPOSE_PROFILES=runner in $ENV_FILE to enable hosted agents)"
    fi
  fi
  echo ""
  echo "  Reaching OneCLI at another address (tunnel, proxy, domain)? Set APP_URL and API_URL in $INSTALL_DIR/.env"
  echo "  Sibling subdomains (app + api.<domain>) share the login automatically; BETTER_AUTH_COOKIE_DOMAIN pins or disables it."
  echo ""
  echo "  Compose file: $COMPOSE_FILE"
  echo ""
  echo "  To stop:   docker compose -p $PROJECT_NAME -f $COMPOSE_FILE down"
  echo "  To update: curl -fsSL https://onecli.sh/install | sh"
  echo ""
}

# Hidden verification hook: print which compose file a version resolves to.
if [ "$1" = "--print-compose-url" ]; then
  compose_url_for_version "${ONECLI_VERSION:-latest}"
  exit 0
fi

main
