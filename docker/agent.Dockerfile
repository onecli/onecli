# OneCLI agent sandbox — the hosted agent's computer (hosted-agents v2, step 2)
# Build context: repo root (run with `docker build -f docker/agent.Dockerfile .`)
#
# Three deliberate divergences from the sibling images, all load-bearing:
# - Base is trixie-slim, NOT alpine: the jcode runtime is a glibc binary —
#   musl can't run it, and it requires glibc >= 2.39 (bookworm's 2.36 is too
#   old) plus a dynamic libssl. The build PROVES the fit below.
# - The jcode RUNTIME is vendored from the pinned GitHub release and
#   checksum-verified, NOT taken from npm: the npm platform packages lag
#   upstream (they still ship the broken v0.67.1), and the runtime
#   self-updates by default — checking on every process start and exec()ing
#   itself mid-run when a newer release exists, which killed every fresh
#   agent's first turn. The pin is three parts: this vendored binary
#   (ONECLI_JCODE_BINARY), JCODE_NO_AUTO_UPDATE baked below, and the
#   supervisor deleting the updater's builds/ dirs from persistent volumes
#   at boot (harness/jcode.ts). @1jehuang/jcode-sdk stays as the CLIENT
#   library only (its wire protocol major is 1 across 0.67.x–0.78.x);
#   its bundled npm binary is deleted from the final image so a
#   misconfiguration fails loudly instead of silently running 0.67.1.
# - pnpm install must NEVER use --omit=optional: other packages' optional
#   deps must still resolve normally (the jcode binaries are pruned
#   explicitly, afterwards, by path).

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-trixie-slim AS base
# openssl: the jcode linux binaries link libssl dynamically (found by the
# proof below — the darwin build is self-contained, the linux one is not);
# installing `openssl` pulls the release's matching libssl runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to the supervisor's packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/sandbox-supervisor --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (never --omit=optional — see header;
# dev deps included, the build needs them)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Vendor the PINNED jcode runtime (checksum- and version-gated)
# ──────────────────────────────────────────────
# The version and its per-arch release checksums are pinned TOGETHER: bumping
# one without the other fails the build. Checksums come from the release's
# published SHA256SUMS asset — verified here unconditionally (the runtime's
# own updater verified only opportunistically, and it is disabled anyway).
FROM base AS jcode-runtime
ARG TARGETARCH
ARG JCODE_VERSION=v0.78.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
    arm64) ASSET="jcode-linux-aarch64"; \
      SHA="91ec4fe88f04aab8f6b294ee319e66701e273a9077003d24fcbf17d14562fd56";; \
    amd64) ASSET="jcode-linux-x86_64"; \
      SHA="4a0c45bf8485785faaeb56384f4741e074e403951a2f179c88ff8c32a7ac3b53";; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1;; \
  esac \
  && curl -fsSL -o /tmp/jcode.tar.gz \
    "https://github.com/1jehuang/jcode/releases/download/${JCODE_VERSION}/${ASSET}.tar.gz" \
  && echo "${SHA}  /tmp/jcode.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/jcode \
  && tar -xzf /tmp/jcode.tar.gz -C /opt/jcode \
  # Known layouts only, or fail HERE rather than at first boot: aarch64 ships
  # the ELF alone; x86_64 ships a launcher script named ${ASSET} plus the
  # real ELF at ${ASSET}.bin (the script resolves the .bin beside its own
  # realpath). Mirror upstream's installer: rename the asset-named entry to
  # `jcode`, keep the .bin's name (the script execs it BY that name), refuse
  # any file we did not expect.
  && for f in /opt/jcode/*; do \
       case "$f" in \
         "/opt/jcode/${ASSET}"|"/opt/jcode/${ASSET}.bin") ;; \
         *) echo "unexpected file in jcode release: $f" >&2; exit 1;; \
       esac; \
     done \
  && mv "/opt/jcode/${ASSET}" /opt/jcode/jcode \
  # Explicit root:root 0755 — never the tarball's embedded uid: the container
  # runs as `node`, and the pinned runtime must be executable, not writable.
  && chown -R root:root /opt/jcode \
  && chmod 0755 /opt/jcode/* \
  && rm /tmp/jcode.tar.gz
# The gate: prove the vendored binary EXECUTES on this glibc base and IS the
# pinned version — a wrong asset, a bad extract, or a silent upstream re-tag
# fails the build, not the first agent boot.
RUN JCODE_NO_AUTO_UPDATE=1 JCODE_NO_TELEMETRY=1 /opt/jcode/jcode --version \
  | grep -F "jcode ${JCODE_VERSION} "

# ──────────────────────────────────────────────
# Stage 5: Build — bundle the supervisor (and its MCP bridge) to dist/
# ──────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm build --filter=@onecli/sandbox-supervisor

# ──────────────────────────────────────────────
# Stage 6: Production node_modules — hoisted (npm-style flat) so the bundle's
# externalized imports resolve from /app/node_modules. Prod-only. The jcode
# SDK's optional platform packages still install (never --omit=optional);
# their stale binary is pruned by path in the runner stage.
# ──────────────────────────────────────────────
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ .
# Append to the repo .npmrc (turbo prune carries it, and its settings must
# stay visible or the frozen-lockfile check rejects the install).
# --ignore-scripts: the root `prepare` hook (husky) is a dev tool absent from
# a --prod install; no production dependency here needs a lifecycle script.
RUN echo "node-linker=hoisted" >> .npmrc \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

# ──────────────────────────────────────────────
# Stage 7: Production runner
# ──────────────────────────────────────────────
FROM node:22.23.2-trixie-slim AS runner
# Dual-licensed image contents: Apache-2.0 plus the enterprise-licensed ee/
# paths compiled/bundled into every edition — see LICENSE and
# LICENSE-ENTERPRISE at the repository root.
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"
WORKDIR /app

# tini as PID 1: Node is not an init (signal handling differs, orphans are
# never reaped). Common tools are the agent's hands — every outbound request
# they make still exits through the gateway (§3.4).
# e2fsprogs + util-linux serve the Kubernetes/Kata boot phase (the sandbox
# manager's boot.sh formats and mounts the raw block home, then setpriv-drops
# to `node` — plans/sandbox-platform.md step 2); inert under the Docker
# backend, where the home arrives as a pre-mounted volume.
# openssh-sftp-server + openssh-client serve the SSH front door (step 5):
# the terminator's relay execs /usr/lib/openssh/sftp-server for sftp and
# modern scp (≥9.0 rides sftp), and openssh-client provides the in-guest scp
# binary legacy `scp -O` targets — no daemon, no listener, the no-inbound
# posture is untouched (and agents get a useful ssh client of their own).
# podman + friends give the agent `docker run`-class work as ROOTLESS
# containers (the `docker` CLI itself arrives via podman-docker). Explicitly
# listed because they are only Recommends of podman: uidmap (setuid
# newuidmap/newgidmap — the user-namespace helpers), passt (pasta, the
# default rootless network) + slirp4netns (fallback), fuse-overlayfs
# (storage fallback; native overlay is the expected driver), aardvark-dns +
# iptables (netavark named networks / compose), catatonit (pod infra /
# --init). This is a capability of the hosted microVM substrate, where each
# sandbox owns a whole kernel; under the self-host Docker backend the same
# binaries are deliberately inert — the runner pins `no-new-privileges` +
# `CapDrop: ALL` on every sandbox (apps/runner/src/backend/docker/
# docker-backend.ts, pinned by its test), which neuters the setuid helpers.
# Never weaken those guards to chase this feature on a shared kernel; see
# /etc/containers/README.onecli (baked below) for the agent-visible note.
# python3 + python3-pip + python3-venv: the agent's second toolchain (node is
# the runtime; python is the lingua franca of one-off scripting). Debian
# marks the interpreter externally-managed (PEP 668), so pip refuses every
# install out of the box — PIP_BREAK_SYSTEM_PACKAGES (env, below) opens it,
# and as uid 1000 the system site-packages is unwritable anyway, so installs
# land in the user scheme under the DURABLE home (~/.local — bin dir shared
# with npm's global prefix). python3-venv also ships the offline pip wheel
# the durable-home gate below installs from.
# nano + less: the SSH front door needs an editor and a pager (neither ships
# in slim, and --no-install-recommends keeps git from pulling less in);
# EDITOR/PAGER/LESS pin them below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini git curl ripgrep ca-certificates openssl e2fsprogs util-linux openssh-sftp-server openssh-client podman podman-docker uidmap passt slirp4netns fuse-overlayfs aardvark-dns catatonit iptables python3 python3-pip python3-venv nano less \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

# Rootless-podman wiring. Four pieces, each load-bearing:
# - /etc/subuid + /etc/subgid: OVERWRITTEN, not appended — the base image
#   already allocates node:100000:65536, and a duplicate row makes newuidmap
#   fail with EINVAL (rootless dead). The range is a DURABLE-DATA FORMAT
#   CONTRACT: it is baked into the ownership of every file podman writes on
#   the persistent home volume, so changing it in a later image strands every
#   existing agent's container storage. Never "tidy" it; the gate below pins
#   the exact value.
# - containers.conf (root-owned): the no-systemd in-sandbox posture —
#   cgroupfs manager with cgroups disabled (limits come from the sandbox
#   itself; there is no journald for events/logs either), and
#   image_copy_tmp_dir="storage" so pull staging lands on the agent's own
#   home volume instead of /var/tmp on the ephemeral rootfs (which sits on
#   shared node storage under Kata). base_hosts_file="" pins "copy the
#   sandbox's /etc/hosts into containers" — the only way a nested container
#   can resolve the gateway proxy host (sandboxes have no DNS egress).
# - registries.conf (root-owned): docker.io for unqualified names, so
#   `podman pull postgres` resolves.
# - storage.conf (node-owned, USER-level — rootless podman ignores the
#   graphroot in /etc/containers/storage.conf): graphroot on /workspace, the
#   durable home, so images/containers/volumes survive relaunch and
#   park/wake. The file stays at its /home/node path ON PURPOSE, even now
#   that ~ lives at /workspace/.home: this copy is image-baked and
#   self-heals every boot (an agent-editable durable copy would not), and
#   the storage path inside it is a DURABLE-DATA FORMAT CONTRACT — moving
#   either strands every existing agent's container store.
#   CONTAINERS_STORAGE_CONF (env, below) pins the same file regardless of
#   where $HOME points.
RUN printf 'node:100000:65536\n' > /etc/subuid \
  && printf 'node:100000:65536\n' > /etc/subgid \
  # Debian installs these setuid already; assert-by-construction, not trust.
  && chmod u+s /usr/bin/newuidmap /usr/bin/newgidmap \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see README.onecli beside this file.' \
    '[containers]' \
    'log_driver = "k8s-file"' \
    'cgroups = "disabled"' \
    'base_hosts_file = ""' \
    '' \
    '[engine]' \
    'cgroup_manager = "cgroupfs"' \
    'events_logger = "file"' \
    'runtime = "crun"' \
    'image_copy_tmp_dir = "storage"' \
    > /etc/containers/containers.conf \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see README.onecli beside this file.' \
    'unqualified-search-registries = ["docker.io"]' \
    > /etc/containers/registries.conf \
  && install -d -o node -g node /home/node/.config /home/node/.config/containers \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see /etc/containers/README.onecli.' \
    '# Storage lives on /workspace (the durable home). This path is a' \
    '# durable-data format contract — never move it, even though ~ is now' \
    '# durable too (/workspace/.home): existing agents own storage HERE.' \
    '# rootless_storage_path is the load-bearing key — rootless podman IGNORES' \
    '# [storage] graphroot from the user config (that is the ROOTFUL path).' \
    '# graphroot is deliberately NOT set: pointing it at the durable home would' \
    '# aim a rootful invocation (e.g. a root kubectl exec, which inherits the' \
    '# global CONTAINERS_STORAGE_CONF) INTO the tenant rootless store, writing' \
    '# root-owned db/lock files that brick it. A rootful podman falls back to' \
    '# ephemeral /var/lib/containers, which is harmless. The store tree itself' \
    '# is pre-created node-owned by agent-entrypoint.sh (podman does not create' \
    '# <graphroot>/tmp before the first pull needs it).' \
    '[storage]' \
    'driver = "overlay"' \
    'rootless_storage_path = "/workspace/.local/share/containers/storage"' \
    > /home/node/.config/containers/storage.conf \
  && chown node:node /home/node/.config/containers/storage.conf \
  && printf '%s\n' \
    'OneCLI agent sandbox — nested containers (podman, plus the `docker` CLI shim).' \
    '' \
    'Rootless podman works on the hosted microVM substrate, where each sandbox' \
    'owns a whole kernel. Under the self-host Docker backend it is intentionally' \
    'disabled: the sandbox hardening (no-new-privileges, CapDrop ALL, and the' \
    'container runtime default seccomp profile) prevents the user-namespace' \
    'setup rootless containers need on a shared kernel. Do not weaken any of' \
    'those to work around it — the shared kernel is the tenant boundary there.' \
    '' \
    'Container storage lives under /workspace/.local/share/containers (the' \
    'durable home), so images, containers, and volumes survive sandbox restarts.' \
    'Running containers stop when the sandbox sleeps; `podman start` them again.' \
    'Outbound traffic from pulls follows the sandbox proxy; a nested container' \
    'inherits the proxy env (both HTTPS_PROXY/HTTP_PROXY and the lowercase' \
    'https_proxy/http_proxy), which carries a credential, so committing a' \
    'container bakes all four into the image config. Scrub ALL of them before' \
    'pushing anywhere, then confirm none survived:' \
    '  podman commit \' \
    '    --change "ENV HTTPS_PROXY=" --change "ENV HTTP_PROXY=" \' \
    '    --change "ENV https_proxy=" --change "ENV http_proxy=" <ctr> <image>' \
    '  podman inspect <image> | grep -i proxy   # must print nothing' \
    > /etc/containers/README.onecli
# The gate (same law as the jcode gate below): prove the runtime surface at
# build time, not at first agent boot. `podman info` is deliberately absent —
# it initializes storage/userns, which a build step must not.
RUN podman --version \
  && docker --version \
  # crun is pinned as the OCI runtime in containers.conf, but Debian satisfies
  # podman's dependency with `crun | runc` — prove the pinned one is actually
  # present, or every `podman run` dies at first use with the build still green.
  && crun --version \
  # The rootless network + storage helpers are Recommends-only (installed
  # explicitly above under --no-install-recommends); prove they landed.
  && command -v pasta \
  && command -v newuidmap \
  && command -v newgidmap \
  && test -u /usr/bin/newuidmap \
  && test -u /usr/bin/newgidmap \
  && test -f /etc/containers/policy.json \
  && [ "$(grep -c '^node:' /etc/subuid)" -eq 1 ] \
  && [ "$(grep -c '^node:' /etc/subgid)" -eq 1 ] \
  && grep -qx 'node:100000:65536' /etc/subuid \
  && grep -qx 'node:100000:65536' /etc/subgid

# The durable POSIX home: ~ = /workspace/.home, ON the home volume. Three
# pieces:
# - usermod: passwd is where the Docker substrate derives HOME from (runc
#   fills HOME from the passwd entry when the env lacks it — spawn AND
#   exec); the hosted boot script and agent-entrypoint.sh export the same
#   literal (byte-equal contract with apps/sandbox-manager/src/constants.ts
#   AGENT_POSIX_HOME).
# - the profile.d drop-in: SSH login shells — Debian's /etc/profile RESETS
#   PATH, so the entrypoint's export cannot survive `bash -l`/`sh -lc`.
#   APPENDED, never prepended: a tenant-writable dir ahead of the system
#   dirs would let a planted binary shadow git/node/curl for every session.
#   POSIX-only syntax — `sh -lc` sessions run dash, which sources
#   /etc/profile.d too.
# - the directory itself is created at CONTAINER runtime by
#   agent-entrypoint.sh as uid 1000 — deliberately NOT here: root must never
#   create tenant-mount dirs, and content baked under /workspace forks the
#   substrates (Docker seeds named volumes from image content; the hosted
#   block mount shadows it).
RUN usermod -d /workspace/.home node \
  && printf '%s\n' \
    '# OneCLI agent sandbox: the durable tool bin (npm -g, pip --user).' \
    '# Appended, never prepended - image binaries must win name lookups.' \
    'case ":$PATH:" in' \
    '  *":/workspace/.home/.local/bin:"*) ;;' \
    '  *) PATH="$PATH:/workspace/.home/.local/bin" ;;' \
    'esac' \
    > /etc/profile.d/onecli-path.sh

ENV NODE_ENV=production
ENV NO_COLOR=1
ENV FORCE_COLOR=0
# Telemetry stays off no matter what spawns the supervisor (§3.5).
ENV JCODE_NO_TELEMETRY=1
# The updater stays off no matter what spawns jcode — the supervisor, a
# docker exec, the agent's own shell. Presence-based upstream: any value
# disables. The supervisor sets it again at launch (belt for non-image runs).
ENV JCODE_NO_AUTO_UPDATE=1

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# Bundles ship sourcemaps; make Node actually use them in stack traces.
ENV NODE_OPTIONS=--enable-source-maps

# Rootless podman's runtime state (locks, conmon sockets, the optional API
# socket) — EPHEMERAL by design: its disappearance across a relaunch is how
# podman detects a "reboot" and resets stale container state. The dir is baked
# into the image so it exists on every fresh rootfs regardless of what spawns
# the process (supervisor, docker exec, an SSH session); on the microVM
# substrate the boot phase additionally mounts a tmpfs over it. Nothing else
# in the image reads XDG_RUNTIME_DIR (no systemd/logind here).
ENV XDG_RUNTIME_DIR=/tmp/onecli-xdg-run
RUN install -d -m 0700 -o node -g node /tmp/onecli-xdg-run
# Belt-and-braces for HOME-less invocations: pin the rootless storage config
# by env too — losing it would land storage on the ephemeral rootfs silently.
ENV CONTAINERS_STORAGE_CONF=/home/node/.config/containers/storage.conf

# `npm -g` and `pip --user` share ONE durable root: both bin dirs unify at
# /workspace/.home/.local/bin — the single PATH entry the entrypoint and
# /etc/profile.d/onecli-path.sh append. ENV (not entrypoint-only) so
# docker-exec / pods-exec sessions inherit it too. Deliberately NO `ENV
# HOME` here: it would poison later build-stage RUNs and fork the
# substrates (Docker seeds named volumes from image content); HOME comes
# from passwd (usermod above), the hosted boot script, and the entrypoint.
ENV NPM_CONFIG_PREFIX=/workspace/.home/.local
# PEP 668 pin — without it every `pip install` on this base refuses. Safe
# here: no system component uses python, and as uid 1000 the system
# site-packages is unwritable, so pip lands in the user scheme under the
# durable ~ (proven by the gate below).
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV EDITOR=nano
ENV PAGER=less
# -F quit-if-one-screen, -R pass colors through, -X no termcap init:
# behaves for SSH humans and non-interactive reads alike (no hung pager in
# a harness shell).
ENV LESS=FRX

# Root-owned on purpose, same law as /opt/jcode below: the container runs as
# `node`, and a runtime-user-writable supervisor (bundle, deps, entrypoint)
# would let the agent rewrite its own harness in a live container. The
# supervisor only ever writes under /workspace and /tmp.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/sandbox-supervisor/dist ./apps/sandbox-supervisor/dist
# The pinned runtime, and the ONLY jcode in this image (see header): the
# supervisor resolves the binary from this env var and refuses to guess.
# The whole DIRECTORY, not one file — on x86_64 `jcode` is a launcher script
# whose ELF payload sits beside it. Root-owned (chown'd in the runtime
# stage): the container runs as `node`, and an owner-writable runtime would
# let the agent overwrite its own harness in a live container.
COPY --from=jcode-runtime /opt/jcode /opt/jcode
ENV ONECLI_JCODE_BINARY=/opt/jcode/jcode
# Drop the npm-bundled v0.67.1 binary so nothing can silently fall back to
# it; the SDK's JS client library stays. Hoisted layout: the platform
# packages sit directly under node_modules/@1jehuang/. Assert the glob
# actually matched (plain ls fails the build on a miss) — a layout change
# must fail HERE, not silently resurrect the stale binary.
RUN ls /app/node_modules/@1jehuang/jcode-linux-*/bin/jcode > /dev/null \
  && rm /app/node_modules/@1jehuang/jcode-linux-*/bin/jcode

COPY docker/agent-entrypoint.sh ./agent-entrypoint.sh
RUN chmod +x ./agent-entrypoint.sh

# The durable home (§3.9): the container is disposable, this is not.
RUN mkdir -p /workspace && chown node:node /workspace
# The durable-home gate (same law as the jcode/podman gates): prove the
# surface at build time, not at first agent boot. setpriv, never `su -l` —
# su strips the ENV these pins live in, so it would test a different
# environment than production runs. The probe home is removed in this same
# layer and BEFORE the VOLUME line: baked /workspace content would seed
# Docker named volumes while the hosted block mount shadows it — a
# substrate fork.
RUN python3 --version \
  && pip3 --version \
  && nano --version \
  && less --version \
  && test "$EDITOR" = "nano" \
  && test "$PAGER" = "less" \
  # usermod took: passwd's home field is the durable literal (the Docker
  # substrate derives HOME from it — spawn and exec).
  && getent passwd node | grep -F ':/workspace/.home:' \
  # The entrypoint seeds from skel on first boot; prove the source exists.
  && test -f /etc/skel/.bashrc \
  && test -f /etc/skel/.profile \
  && test -f /etc/profile.d/onecli-path.sh \
  # Login shells: /etc/profile resets PATH; the drop-in must append the
  # workspace bin — and the system dirs must still win name lookups.
  && setpriv --reuid node --regid node --init-groups \
       env HOME=/workspace/.home bash -lc 'case ":$PATH:" in (*":/workspace/.home/.local/bin:"*) exit 0;; (*) exit 1;; esac' \
  && [ "$(setpriv --reuid node --regid node --init-groups env HOME=/workspace/.home bash -lc 'command -v node')" = "/usr/local/bin/node" ] \
  # npm's global prefix rides the baked env everywhere (spawn and exec).
  && [ "$(setpriv --reuid node --regid node --init-groups env HOME=/workspace/.home npm config get prefix)" = "/workspace/.home/.local" ] \
  # pip --user REALLY installs on this base: PEP 668 pin honored, user
  # scheme lands in the shared bin dir. Offline — python3-venv ships pip's
  # own wheel; a missing wheel fails the glob loudly. venv is proven
  # end-to-end in the same breath.
  && setpriv --reuid node --regid node --init-groups sh -c ' \
       set -e; export HOME=/workspace/.home; mkdir -p "$HOME"; \
       pip3 install --user --quiet --no-index --no-deps /usr/share/python-wheels/pip-*.whl; \
       test -x "$HOME/.local/bin/pip"; \
       python3 -m venv "$HOME/gate-venv"; \
       "$HOME/gate-venv/bin/pip" --version' \
  && rm -rf /workspace/.home
VOLUME ["/workspace"]

USER node

CMD ["./agent-entrypoint.sh"]
