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
# This script checks for Docker, downloads the docker-compose.yml,
# and starts OneCLI (app + PostgreSQL) on ports 10254 and 10255.

INSTALL_DIR="$HOME/.onecli"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
COMPOSE_URL="https://raw.githubusercontent.com/onecli/onecli/main/docker/docker-compose.yml"
PROJECT_NAME="onecli"

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

main() {
  echo ""
  echo "  OneCLI: give your agents access, not your secrets."
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

  # ── Stop existing services ──

  if docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
    echo "  Stopping existing OneCLI services..."
    if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down; then
      echo "Error: Failed to stop existing OneCLI services." >&2
      exit 1
    fi
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
    exit 1
  fi

  # ── Success ──

  echo ""
  echo "  OneCLI is running!"
  echo ""
  echo "  Dashboard:  http://$ONECLI_BIND_HOST:10254"
  echo "  Gateway:    http://$ONECLI_BIND_HOST:10255"
  echo ""
  echo "  Compose file: $COMPOSE_FILE"
  echo ""
  echo "  To stop:   docker compose -p $PROJECT_NAME -f $COMPOSE_FILE down"
  echo "  To update: curl -fsSL https://onecli.sh/install | sh"
  echo ""
}

main
