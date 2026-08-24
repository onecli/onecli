#!/bin/sh

# OneCLI - Open-Source Credential Vault for AI Agents
# Source: https://github.com/onecli/onecli
# License: See repository for license details
#
# Usage: curl -fsSL https://onecli.sh/install | sh
#
# The URL people open OneCLI at (the ONE networking var most installs set —
# every other address derives from it; http means ports, https means a proxy):
#   export ONECLI_EXTERNAL_URL=http://192.168.1.50:10254
#   curl -fsSL https://onecli.sh/install | sh
#
# Custom bind host (which interface the ports publish on; listen-only):
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
# Re-running this script IS the update path: it refreshes every image — the
# agent sandbox image included, which `docker compose pull` cannot reach — and
# then restarts this installation's agent sandboxes so they come back on the
# new image. Keep them running instead (they stay on the old agent image until
# they next restart on their own):
#   export ONECLI_KEEP_SANDBOXES=1
#   curl -fsSL https://onecli.sh/install | sh
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
# Docker command indirection, so the tests can substitute a stub and assert
# exactly which calls the upgrade steps make — and, critically, which they
# never make (see reap_sandboxes). docker/migrate.sh carries PRISMA_CMD for
# the same reason. Only the upgrade helpers below read it; the prerequisite
# checks deliberately probe the real binary.
DOCKER="${ONECLI_DOCKER_CMD:-docker}"

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

  # 2. A previously persisted decision — the install's own .env is the record
  # (parity with the setup wizard, which persists its detection too).
  if [ -f "$ENV_FILE" ]; then
    _persisted=$(grep "^ONECLI_BIND_HOST=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
    if [ -n "$_persisted" ]; then
      echo "$_persisted"
      return
    fi
  fi

  # 3. macOS — Docker Desktop, loopback works
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "127.0.0.1"
    return
  fi

  # 4. WSL — same VM routing as macOS (check /proc, not env vars)
  if [ -f /proc/sys/fs/binfmt_misc/WSLInterop ]; then
    echo "127.0.0.1"
    return
  fi

  # 5. Bare-metal Linux — bind to docker0 bridge IP
  if command -v ip >/dev/null 2>&1; then
    DOCKER0_IP=$(ip -4 addr show docker0 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]; exit}')
    if [ -n "$DOCKER0_IP" ]; then
      echo "$DOCKER0_IP"
      return
    fi
  fi

  # 6. Cannot determine safely
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

strip_trailing_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

# LEGACY(next-major): whether a bind host may seed the canonical URL —
# non-blank, non-loopback, non-wildcard, the SAME rule as the resolver, the
# wizard, and the gateway mirror (ledger: packages/api/src/lib/public-origins.ts). A loopback bind means the localhost defaults are already right; a
# wildcard is a listen address that must never become an advertised one (the
# resolver rejects it at boot, so freezing it would crash-loop the stack).
bind_seeds_url() {
  case "$1" in
    "" | 127.0.0.1 | ::1 | "[::1]" | localhost | 0.0.0.0 | :: | "[::]") return 1 ;;
  esac
  return 0
}

# A variable's effective value the way compose interpolation sees it: the
# shell export wins, then the install's own .env line.
env_or_file() {
  eval _v="\${$1:-}"
  if [ -n "$_v" ]; then
    printf '%s' "$_v"
    return
  fi
  if [ -f "$ENV_FILE" ]; then
    # Trailing whitespace and a CRLF carriage return are stripped, exactly as
    # compose does when it reads the same file. Without this a .env saved on
    # Windows/WSL hands back "rnr_x\r", which hashes to a fingerprint matching
    # no container: the sandbox sweep then finds nothing and reports success.
    # The EXPORT branch above is deliberately left verbatim, since that is the
    # value compose itself interpolates.
    grep "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*$//'
  fi
}

# One layer of surrounding quotes off an .env value. `env_or_file` hands back
# the raw right-hand side, and compose accepts either style, so a quoted
# RUNNER_TOKEN would otherwise hash to the wrong fingerprint.
unquote() {
  _u="$1"
  case "$_u" in
    '"'*'"')
      _u="${_u#\"}"
      _u="${_u%\"}"
      ;;
    "'"*"'")
      _u="${_u#\'}"
      _u="${_u%\'}"
      ;;
  esac
  printf '%s' "$_u"
}

# Whether hosted agents are enabled for this install. The runner profile is
# what creates sandboxes and what makes the agent image worth pulling, so both
# upgrade steps below hang off it.
runner_profile_on() {
  case "$(env_or_file COMPOSE_PROFILES)" in
    *runner*) return 0 ;;
  esac
  return 1
}

# The agent sandbox image this install starts agents from. It is deliberately
# NOT a compose service — it is one env value on the runner service — so
# `docker compose pull` cannot see it and this script has to pull it by name.
agent_image_ref() {
  _ref=$(unquote "$(env_or_file RUNNER_AGENT_IMAGE)")
  if [ -n "$_ref" ]; then
    printf '%s' "$_ref"
    return
  fi
  printf 'ghcr.io/onecli/onecli-agent:%s' "${ONECLI_VERSION:-latest}"
}

# Whether a reference names a registry we may pull from. Docker treats the
# first path segment as a registry only when it contains a "." or a ":", so a
# locally built tag like `onecli-agent:dev` (what the wizard's source mode
# builds) would silently resolve to docker.io/library/onecli-agent and pull a
# stranger's image. Refusing is a supply-chain guard, not tidiness.
ref_is_pullable() {
  case "$1" in
    */*) ;;
    *) return 1 ;;
  esac
  case "${1%%/*}" in
    *.* | *:*) return 0 ;;
  esac
  return 1
}

# A stable, non-secret fingerprint of THIS installation: sha256 of the runner
# token, first 32 hex. Byte-equal with apps/runner/src/installation.ts, which
# stamps the same value onto every sandbox container as sh.onecli.installation
# — that label is what fences the restart below to our own containers.
#
# `printf`, never `echo`: echo appends a newline, which hashes to an entirely
# different value, and the label filter would then match nothing while still
# reporting success. A silent no-op that looks like it ran is the worst
# possible failure here, so a test pins the exact digest.
installation_fingerprint() {
  _token=$(unquote "$(env_or_file RUNNER_TOKEN)")
  [ -n "$_token" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$_token" | sha256sum | cut -c1-32
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$_token" | shasum -a 256 | cut -c1-32
  else
    return 1
  fi
}

# Restart this installation's agent sandboxes so they come back on the image we
# just pulled. Sandbox containers are created by the runner through the Docker
# API rather than by compose, so they carry no compose labels and `compose
# down` never touches them: without this they keep running the OLD agent image
# indefinitely, which is the whole bug this step exists to close.
#
# BOTH labels are required. `managed=1` alone would also match a co-located
# install's containers — precisely the failure apps/runner/src/installation.ts
# was written to prevent. No fingerprint means no sweep: never widen the fence.
#
# CONTAINERS ONLY. The durable home volumes carry the IDENTICAL label pair, so
# this filter must never reach `docker volume`, `docker rm -v`, or a prune:
# that would erase every agent's /workspace. A test asserts those calls are
# never made.
#
# Sets REAPED to the number of sandboxes actually stopped, and REAP_KEPT when
# the operator opted out. The success block does the reporting, so every
# "Agents:" line the run prints stays together.
reap_sandboxes() {
  REAPED=0
  REAP_KEPT=""
  [ "$STACK" = "split" ] || return 0
  runner_profile_on || return 0
  # Through env_or_file, like every other knob, so it works as a shell export
  # AND as a line in the install's .env. A bare `$ONECLI_KEEP_SANDBOXES` would
  # only ever see the export, and in the documented `curl | sh` form a variable
  # prefix binds to curl, not to the script.
  if [ -n "$(env_or_file ONECLI_KEEP_SANDBOXES)" ]; then
    REAP_KEPT="yes"
    return 0
  fi
  _fp=$(installation_fingerprint) || return 0
  [ -n "$_fp" ] || return 0
  _ids=$($DOCKER ps -q \
    --filter "label=sh.onecli.managed=1" \
    --filter "label=sh.onecli.installation=$_fp" 2>/dev/null)
  [ -n "$_ids" ] || return 0
  # -t 30 matches the runner's own graceful stop. The runner recreates the
  # container from the current image on the agent's next message, so stopping
  # is enough; removing it would only make the control plane wait longer.
  for _id in $_ids; do
    if $DOCKER stop -t 30 "$_id" >/dev/null 2>&1; then
      REAPED=$((REAPED + 1))
    fi
  done
  return 0
}

# Strict validation for the canonical var only (legacy APP_URL stays lenient):
# scheme required, no path or query, never a wildcard bind address. Every
# refusal names the fix.
validate_external_url() {
  case "$1" in
    http://* | https://*) ;;
    *)
      echo "Error: ONECLI_EXTERNAL_URL=\"$1\" has no scheme." >&2
      echo "Write http:// or https:// explicitly (http means ports; https means a proxy)." >&2
      return 1
      ;;
  esac
  _hostpart="${1#*://}"
  case "$_hostpart" in
    */* | *\?*)
      echo "Error: ONECLI_EXTERNAL_URL=\"$1\" carries a path or query." >&2
      echo "Use scheme://host[:port] only; subpath serving is unsupported." >&2
      return 1
      ;;
  esac
  case "$_hostpart" in
    0.0.0.0 | 0.0.0.0:* | \[::\] | \[::\]:*)
      echo "Error: ONECLI_EXTERNAL_URL=\"$1\" names a bind address." >&2
      echo "Set ONECLI_BIND_HOST for where ports publish, and ONECLI_EXTERNAL_URL to the address people browse to." >&2
      return 1
      ;;
  esac
}

# The canonical-URL record in the install's .env: honor an exported value
# (validated), keep any existing configuration, freeze the detected address
# when the bind is non-loopback (the pre-refactor compose behavior, now
# written down), and leave a self-documenting hint otherwise. A later run
# whose exported value differs never overwrites the file (keep-existing law);
# compose still prefers the export for that run.
provision_external_url() {
  if [ -n "${ONECLI_EXTERNAL_URL:-}" ]; then
    _url=$(strip_trailing_slashes "$ONECLI_EXTERNAL_URL")
    validate_external_url "$_url" || return 1
    ensure_env_value ONECLI_EXTERNAL_URL "$_url"
    return 0
  fi
  if [ -f "$ENV_FILE" ] && grep -q "^ONECLI_EXTERNAL_URL=\|^APP_URL=" "$ENV_FILE"; then
    return 0
  fi
  if [ -n "${APP_URL:-}" ]; then
    return 0
  fi
  if bind_seeds_url "$ONECLI_BIND_HOST"; then
    _url="http://$ONECLI_BIND_HOST:${ONECLI_APP_PORT:-10254}"
    # Defense in depth: an exotic bind value that would not survive the
    # resolver's boot validation gets the hint instead of a frozen line the
    # stack then refuses to start with.
    if validate_external_url "$_url" 2>/dev/null; then
      printf '# Frozen at install from the detected bind address; edit to the address people browse to.\n' >> "$ENV_FILE"
      printf 'ONECLI_EXTERNAL_URL=%s\n' "$_url" >> "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      return 0
    fi
  fi
  if ! grep -q "ONECLI_EXTERNAL_URL" "$ENV_FILE" 2>/dev/null; then
    printf '# The URL people open OneCLI at; every other address derives from it.\n' >> "$ENV_FILE"
    printf '# http means ports; https means a proxy in front. Uncomment to change:\n' >> "$ENV_FILE"
    printf '# ONECLI_EXTERNAL_URL=http://localhost:%s\n' "${ONECLI_APP_PORT:-10254}" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

# The addresses the stack will actually advertise — the POSIX re-statement of
# the resolver's chain head, for the success block and the --print-resolved
# verification hook. Sets RESOLVED_EXTERNAL / RESOLVED_API / RESOLVED_GATEWAY.
resolve_display_urls() {
  RESOLVED_EXTERNAL=$(env_or_file ONECLI_EXTERNAL_URL)
  _class="canonical"
  if [ -z "$RESOLVED_EXTERNAL" ]; then
    RESOLVED_EXTERNAL=$(env_or_file APP_URL)
    _class="alias"
  fi
  if [ -z "$RESOLVED_EXTERNAL" ]; then
    if bind_seeds_url "$ONECLI_BIND_HOST"; then
      RESOLVED_EXTERNAL="http://$ONECLI_BIND_HOST:${ONECLI_APP_PORT:-10254}"
    else
      RESOLVED_EXTERNAL="http://localhost:${ONECLI_APP_PORT:-10254}"
    fi
    _class="derived"
  fi
  RESOLVED_EXTERNAL=$(strip_trailing_slashes "$RESOLVED_EXTERNAL")
  # A bare legacy APP_URL never derives the other origins (frozen contract);
  # canonical and detected addresses do: https means one proxied origin with
  # the gateway under /gw, http means same host on the service ports.
  if [ "$_class" = "alias" ]; then
    RESOLVED_API="http://localhost:${ONECLI_API_PORT:-10256}"
    RESOLVED_GATEWAY="http://localhost:${ONECLI_GATEWAY_PORT:-10255}"
    return
  fi
  case "$RESOLVED_EXTERNAL" in
    https://*)
      RESOLVED_API="$RESOLVED_EXTERNAL"
      RESOLVED_GATEWAY="$RESOLVED_EXTERNAL/gw"
      ;;
    *)
      _host="${RESOLVED_EXTERNAL#*://}"
      _host="${_host%%:*}"
      RESOLVED_API="http://$_host:${ONECLI_API_PORT:-10256}"
      RESOLVED_GATEWAY="http://$_host:${ONECLI_GATEWAY_PORT:-10255}"
      ;;
  esac
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

  # ── Persist the publish-plane decisions ──
  # The install's .env is the record: a later bare `docker compose up` must
  # reproduce exactly this install (an exported-only bind used to silently
  # revert to loopback). Exported custom ports are recorded for the same
  # reason; defaults stay implicit.

  ensure_env_value ONECLI_BIND_HOST "$ONECLI_BIND_HOST"
  for pair in "ONECLI_APP_PORT:${ONECLI_APP_PORT:-}" "ONECLI_GATEWAY_PORT:${ONECLI_GATEWAY_PORT:-}" "ONECLI_API_PORT:${ONECLI_API_PORT:-}" "POSTGRES_PORT:${POSTGRES_PORT:-}"; do
    _var="${pair%%:*}"
    _val="${pair#*:}"
    if [ -n "$_val" ]; then
      ensure_env_value "$_var" "$_val"
    fi
  done

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
    # The canonical public URL (validated, persisted, frozen, or hinted).
    provision_external_url || exit 1
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
  # Effective values, not just exports: compose interpolation reads the
  # install's .env too, so a port persisted by a previous run must be the one
  # probed here.

  PG_PORT=$(env_or_file POSTGRES_PORT)
  PG_PORT="${PG_PORT:-5432}"
  if port_in_use "$PG_PORT"; then
    echo "Error: Port $PG_PORT is already in use (probably a local PostgreSQL)." >&2
    echo "" >&2
    echo "Pick a free port for OneCLI's database:" >&2
    echo "  export POSTGRES_PORT=5433" >&2
    echo "  curl -fsSL https://onecli.sh/install | sh" >&2
    exit 1
  fi

  if [ "$STACK" = "split" ]; then
    for pair in "ONECLI_APP_PORT:$(env_or_file ONECLI_APP_PORT):10254" "ONECLI_GATEWAY_PORT:$(env_or_file ONECLI_GATEWAY_PORT):10255" "ONECLI_API_PORT:$(env_or_file ONECLI_API_PORT):10256"; do
      var="${pair%%:*}"
      _rest="${pair#*:}"
      port="${_rest%%:*}"
      port="${port:-${_rest#*:}}"
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

  # The agent sandbox image is not a compose service, so the pull above did not
  # fetch it. Skipping this is how an upgraded install ends up serving 2.x
  # services from a stale agent image: the runner only pulls that image when it
  # is missing entirely, which never happens once a moving tag is cached.
  #
  # Non-fatal on purpose. It is the largest image by far, and a flaky network
  # must not abort an upgrade whose services are already pulled; the warning
  # names the exact consequence instead.
  AGENT_PULL_FAILED=""
  if [ "$STACK" = "split" ] && runner_profile_on; then
    AGENT_IMAGE=$(agent_image_ref)
    if ref_is_pullable "$AGENT_IMAGE"; then
      echo "  Pulling the agent sandbox image ($AGENT_IMAGE)..."
      if ! $DOCKER pull "$AGENT_IMAGE"; then
        AGENT_PULL_FAILED="yes"
        echo "Warning: Failed to pull $AGENT_IMAGE." >&2
        echo "  OneCLI will still start, but hosted agents keep using the agent image already on this host." >&2
      fi
    else
      # Not "built locally": a two-segment ref like myorg/agent:1 is a real
      # Docker Hub reference we refuse on purpose, because pulling it could
      # replace a locally built image from a namespace we do not control.
      # Name the reason and the way out instead of guessing at intent.
      echo "  Agent image $AGENT_IMAGE names no registry host, so it is not pulled."
      echo "  Prefix it with ghcr.io/ or docker.io/ in $ENV_FILE to have it pulled."
    fi
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

  # ── Move running agents onto the new image ──
  # After `up`, so the runner is already reconciling and reports the stopped
  # sandbox on its first pass rather than waiting out an interval.

  reap_sandboxes

  # ── Success ──

  echo ""
  echo "  OneCLI is running!"
  echo ""
  if [ "$STACK" = "split" ]; then
    resolve_display_urls
    echo "  Dashboard:  $RESOLVED_EXTERNAL"
    echo "  Gateway:    $RESOLVED_GATEWAY"
    echo "  API:        $RESOLVED_API"
    if runner_profile_on; then
      echo "  Agents:     hosted agents are ON (the runner mounts the Docker socket to start sandboxes;"
      echo "              disable with COMPOSE_PROFILES= in $ENV_FILE)"
      if [ -n "$REAP_KEPT" ]; then
        echo "              running sandboxes left alone (ONECLI_KEEP_SANDBOXES is set); they keep the"
        echo "              old agent image until they next restart"
      elif [ "$REAPED" -gt 0 ]; then
        # "current", not "new": the pull above is non-fatal, so this may well
        # be the same image they were already on. Claiming otherwise would
        # send an operator hunting for a version bump that never happened.
        echo "              restarted $REAPED running sandbox(es) onto the current agent image; any turn"
        echo "              in flight reports that the agent restarted, and every /workspace is intact"
        if [ -n "$AGENT_PULL_FAILED" ]; then
          echo "              (the agent image pull failed above, so that is the image already on this host)"
        fi
      fi
    else
      echo "  Agents:     off (set COMPOSE_PROFILES=runner in $ENV_FILE to enable hosted agents)"
    fi
  else
    echo "  Dashboard:  http://$ONECLI_BIND_HOST:${ONECLI_APP_PORT:-10254}"
    echo "  Gateway:    http://$ONECLI_BIND_HOST:${ONECLI_GATEWAY_PORT:-10255}"
  fi
  echo ""
  echo "  Reaching OneCLI at another address (tunnel, proxy, domain)? Set ONECLI_EXTERNAL_URL in $INSTALL_DIR/.env"
  echo "  to the URL you browse to (http means ports; https means a proxy in front)."
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

# Hidden verification hook: run only the bind-persist + external-URL
# provisioning against $HOME/.onecli/.env (no Docker needed), so tests can
# assert the persist/freeze/hint behavior file-wise.
if [ "$1" = "--provision-url-env" ]; then
  ONECLI_BIND_HOST=$(detect_bind_host)
  if [ -z "$ONECLI_BIND_HOST" ]; then
    echo "Error: Could not safely determine a bind address for OneCLI." >&2
    exit 1
  fi
  mkdir -p "$INSTALL_DIR"
  ensure_env_value ONECLI_BIND_HOST "$ONECLI_BIND_HOST"
  provision_external_url || exit 1
  exit 0
fi

# Hidden verification hook: print the addresses the stack would advertise.
if [ "$1" = "--print-resolved" ]; then
  ONECLI_BIND_HOST=$(detect_bind_host)
  resolve_display_urls
  echo "external=$RESOLVED_EXTERNAL"
  echo "api=$RESOLVED_API"
  echo "gateway=$RESOLVED_GATEWAY"
  exit 0
fi

# Hidden verification hook: print the agent sandbox image this install pulls,
# resolved exactly as the pull step resolves it.
if [ "$1" = "--print-agent-image" ]; then
  ONECLI_VERSION="${ONECLI_VERSION:-latest}"
  printf '%s\n' "$(agent_image_ref)"
  exit 0
fi

# Hidden verification hook: whether a reference would be pulled from a
# registry or treated as locally built. This is the supply-chain guard, so its
# edge cases are pinned by tests rather than trusted.
if [ "$1" = "--print-ref-pullable" ]; then
  if ref_is_pullable "$2"; then
    echo "pullable"
  else
    echo "local"
  fi
  exit 0
fi

# Hidden verification hook: print this installation's sandbox-label
# fingerprint, so a test can pin it against apps/runner/src/installation.ts.
if [ "$1" = "--print-installation-id" ]; then
  installation_fingerprint || exit 1
  exit 0
fi

# Hidden verification hook: run ONLY the sandbox restart, through
# $ONECLI_DOCKER_CMD, so tests can assert every docker call it makes and every
# destructive one it must never make.
if [ "$1" = "--reap-sandboxes" ]; then
  STACK="split"
  reap_sandboxes
  echo "reaped=$REAPED"
  echo "kept=$REAP_KEPT"
  exit 0
fi

main
