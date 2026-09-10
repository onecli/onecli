#!/bin/sh
set -e

# Entrypoint for the agent sandbox image (docker/agent.Dockerfile).
#
# Rootless CA trust: the gateway's MITM CA arrives as a mounted file (the
# container-config payload names it in NODE_EXTRA_CA_CERTS). Inside the
# sandbox every TLS handshake presents the gateway's certificate — egress is
# gateway-only (§3.4) — so this one CA is the only trust anyone needs:
# - NODE_EXTRA_CA_CERTS: the supervisor's Node runtime (set by the payload).
# - SSL_CERT_FILE: the jcode runtime (rustls-native-certs honors it; verified).
# - CURL_CA_BUNDLE / GIT_SSL_CAINFO: the agent's common tools.
# - Chromium reads none of these; it gets the CA imported into its NSS DB
#   below, once HOME exists.
# System-store installation (update-ca-certificates, needs root) arrives with
# step 3's runner-controlled spawn.
CA_FILE="${NODE_EXTRA_CA_CERTS:-/tmp/onecli-gateway-ca.pem}"
if [ -f "$CA_FILE" ]; then
  export SSL_CERT_FILE="$CA_FILE"
  export CURL_CA_BUNDLE="$CA_FILE"
  export GIT_SSL_CAINFO="$CA_FILE"
else
  echo "agent-entrypoint: no CA file at $CA_FILE — TLS through the gateway will fail" >&2
fi

# The durable POSIX home: ~ lives ON the home volume (/workspace), so
# dotfiles, shell history, `npm -g` and `pip --user` installs survive a
# sandbox relaunch and park/wake. Byte-equal contract with the image's
# passwd entry (agent.Dockerfile `usermod -d`), the hosted boot script's
# export (apps/sandbox-manager/src/constants.ts AGENT_POSIX_HOME), and
# /etc/profile.d/onecli-path.sh. Re-exported here unconditionally so the
# image is self-contained under ANY spawner — an older boot script, a bare
# `docker run` — and created HERE, post-drop, as uid 1000: root must never
# create directories under the tenant-writable mount (a planted symlink
# would hand root a mkdir/chown target). Best-effort like the store tree
# below — a home this process can't write is already a fatal problem the
# supervisor reports; never block boot on it.
export HOME=/workspace/.home
if [ ! -d "$HOME" ]; then
  # First boot on this volume (or a restored pre-change home): seed the
  # shell dotfiles ONCE. Guarded on the directory, not per file — a
  # per-file reseed would resurrect a dotfile the agent deliberately
  # deleted — and never `cp -n`, which exits nonzero on a skipped copy
  # (coreutils >= 9.2), a boot killer under set -e.
  mkdir -p "$HOME" 2>/dev/null || true
  cp /etc/skel/.bashrc /etc/skel/.profile "$HOME/" 2>/dev/null || true
fi
# Where `npm -g` and `pip --user` land (NPM_CONFIG_PREFIX bakes the same
# root): pre-created so the first install and the first PATH lookup never
# race. Idempotent — a restored home already has it.
mkdir -p "$HOME/.local/bin" 2>/dev/null || true

# Chromium trust. On Linux chromium reads neither SSL_CERT_FILE nor
# NODE_EXTRA_CA_CERTS: its only trust store is the NSS shared DB at
# ~/.pki/nssdb (chromium docs, linux/cert_management.md; M146+ defaults to
# ~/.local/share/pki/nssdb but keeps using ~/.pki/nssdb when it exists, so
# this one path covers every build, including one Playwright downloads).
# Without the gateway CA there every page load through the MITM fails
# ERR_CERT_AUTHORITY_INVALID, and the escape an agent finds by trial is
# ignoreHTTPSErrors — verification off for every site (measured live on
# prod, 2026-09-09). So import it here, as uid 1000, onto the durable home,
# after HOME exists:
# - the nickname carries the CA's fingerprint, which makes the import
#   idempotent (present → nothing to do) and rotation-safe (a new gateway
#   CA gets its own entry and the previous onecli-gateway-* entries go);
#   the onecli-gateway-* nickname prefix is this script's namespace —
#   anything else in the DB, whatever the agent added, is never touched;
# - "C,," trusts the CA for TLS server auth only;
# - the DB is created only when absent — never recreated over the agent's;
# - best-effort: any failure is one stderr line and boot continues. The
#   browser is one tool; the supervisor must come up regardless.
if [ -f "$CA_FILE" ] && command -v certutil >/dev/null 2>&1; then
  NSSDB="$HOME/.pki/nssdb"
  CA_FP="$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 2>/dev/null \
    | cut -d= -f2 | tr -d ':' | cut -c1-16)"
  if [ -z "$CA_FP" ]; then
    echo "agent-entrypoint: $CA_FILE is not a readable certificate — chromium will not trust the gateway" >&2
  else
    NICK="onecli-gateway-$CA_FP"
    mkdir -p "$NSSDB" 2>/dev/null || true
    if [ ! -f "$NSSDB/cert9.db" ]; then
      certutil -d "sql:$NSSDB" -N --empty-password >/dev/null 2>&1 || true
    fi
    if ! certutil -d "sql:$NSSDB" -L -n "$NICK" >/dev/null 2>&1; then
      certutil -d "sql:$NSSDB" -L 2>/dev/null | awk '$1 ~ /^onecli-gateway-/ {print $1}' \
        | while read -r stale; do
            certutil -d "sql:$NSSDB" -D -n "$stale" >/dev/null 2>&1 || true
          done
      certutil -d "sql:$NSSDB" -A -t "C,," -n "$NICK" -i "$CA_FILE" >/dev/null 2>&1 \
        || echo "agent-entrypoint: could not import the gateway CA into $NSSDB — chromium will not trust the gateway" >&2
    fi
  fi
fi

# ONE PATH entry, APPENDED — image binaries must keep winning every name
# lookup (a tenant-writable dir ahead of /usr/bin would let a planted
# binary shadow git/node/curl for the whole process tree). The case guard
# keeps it single across re-entrant spawns. Login shells get the same
# append from /etc/profile.d/onecli-path.sh — Debian's /etc/profile RESETS
# PATH, so this export alone cannot survive `bash -l` (the SSH door).
case ":$PATH:" in
  *":/workspace/.home/.local/bin:"*) ;;
  *) PATH="$PATH:/workspace/.home/.local/bin" ;;
esac
export PATH

# Nix (Tier 1.5), when this agent has installed it (onecli-nix-install).
# NEVER source the profile hook here: ~/.nix-profile/etc/profile.d/nix.sh
# is agent-writable, and this shell is the SUPERVISOR's (it ends in `exec
# node`) — sourcing it would hand the agent arbitrary code in the
# supervisor's process image before the harness even starts (the review's
# security-onecli §6 finding). Nix needs exactly one thing from the
# environment to work: its bin dir on PATH (measured: nix, nix profile, and
# installed programs all run with only PATH set). So set that, and:
# - APPEND, never prepend: the hook itself prepends, but the image's law is
#   that a tenant-writable dir never sits ahead of the system dirs — the
#   `exec node` below is a bare-name lookup, and `nix profile add
#   nixpkgs#nodejs` must not swap the supervisor's runtime. Same slot as
#   ~/.local/bin. Both the legacy (~/.nix-profile) and the XDG
#   (~/.local/state/nix/profile) link are covered; nix.sh's own precedence
#   is XDG when present.
# - NIX_SSL_CERT_FILE from SSL_CERT_FILE: the hook would set the SYSTEM
#   bundle, which lacks the gateway CA; Nix's precedence is
#   NIX_SSL_CERT_FILE > SSL_CERT_FILE, so an explicit value is what makes
#   every nix download through the gateway trust the MITM (measured).
# - USER: nix's own tooling (and the hook, for shells the AGENT opens and
#   sources it in) guards on it. The hosted boot script exports it; a bare
#   `docker run` does not.
export USER="${USER:-node}"
NIX_PROFILE_LINK="$HOME/.local/state/nix/profile"
[ -e "$NIX_PROFILE_LINK" ] || NIX_PROFILE_LINK="$HOME/.nix-profile"
if [ -e "$NIX_PROFILE_LINK/bin/nix" ]; then
  case ":$PATH:" in
    *":$NIX_PROFILE_LINK/bin:"*) ;;
    *) PATH="$PATH:$NIX_PROFILE_LINK/bin" ;;
  esac
  export PATH
  if [ -n "${SSL_CERT_FILE:-}" ]; then
    export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"
  fi
fi
unset NIX_PROFILE_LINK

# Rootless podman keeps its image/container store on the durable home
# (/workspace, per the baked storage.conf's rootless_storage_path), so it
# survives a sandbox relaunch and park/wake. Pre-create the store tree
# node-owned: podman does not create <graphroot>/tmp before the first pull's
# store-init needs it (and image_copy_tmp_dir="storage" stages pulls there,
# off the shared node disk). Best-effort — a home this process can't write is
# already a fatal problem the supervisor reports; never block boot on it.
# Idempotent: a restored home already has the tree, with the agent's images.
mkdir -p /workspace/.local/share/containers/storage/tmp 2>/dev/null || true

exec node apps/sandbox-supervisor/dist/index.mjs
