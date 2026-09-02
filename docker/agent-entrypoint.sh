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
