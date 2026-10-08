# OneCLI agent sandbox — the hosted agent's computer
# Build context: repo root (run with `docker build -f docker/agent.Dockerfile .`)
#
# Two images: docker/agent-base.Dockerfile is the OS surface (the
# one big apt layer and what depends only on it); THIS file builds the app
# and stacks it on that base through `ARG AGENT_BASE_IMAGE` (Stage 7). Build
# the base first (`pnpm agent:build` does both), or pass a registry
# reference. Stages 1 to 6 never leave the builder.
#
# Three deliberate divergences from the sibling images, all load-bearing:
# - Base is trixie-slim, NOT alpine: the jcode runtime is a glibc binary —
#   musl can't run it, and it requires glibc >= 2.39 (bookworm's 2.36 is too
#   old) plus a dynamic libssl. The build PROVES the fit below. The build
#   stages here and the agent base image share the same Node pin.
# - The jcode RUNTIME is vendored from the pinned GitHub release and
#   checksum-verified, NOT taken from npm: the npm platform packages lag
#   upstream (they still ship the broken v0.67.1), and the runtime
#   self-updates by default — checking on every process start and exec()ing
#   itself mid-run when a newer release exists, which killed every fresh
#   agent's first turn. The pin is three parts: this vendored binary
#   (ONECLI_JCODE_BINARY), JCODE_NO_AUTO_UPDATE baked below, and the
#   supervisor deleting the updater's builds/ dirs from persistent volumes
#   at boot (harness/jcode.ts). @1jehuang/jcode-sdk stays as the CLIENT
#   library only (its wire protocol major is 1 across 0.67.x–0.90.x);
#   its bundled npm binary is deleted from the final image so a
#   misconfiguration fails loudly instead of silently running 0.67.1.
# - pnpm install must NEVER use --omit=optional: other packages' optional
#   deps must still resolve normally (the jcode binaries are pruned
#   explicitly, afterwards, by path).

# The base the runner stage (Stage 7) stacks on. Declared HERE, before any
# FROM: an ARG used in a FROM line must be a global one (Dockerfile rule),
# and a later re-declaration would reset it to blank. The default is the tag
# `pnpm agent:build` builds first; a deployment and publish.yml pass a
# registry reference pinned by digest.
ARG AGENT_BASE_IMAGE=onecli-agent-base:local

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
ARG JCODE_VERSION=v0.90.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
    arm64) ASSET="jcode-linux-aarch64"; \
      SHA="85c095f6ec90bdf06cce2ee9666fa40fc74d05c6aca65e475bc12978af45f16e";; \
    amd64) ASSET="jcode-linux-x86_64"; \
      SHA="9a46e0cd4b66416177e78384614787323be7a9d195832733664e8f0354a9927b";; \
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
# Stage 4b: Vendor the PINNED Nix release (checksum-gated), UNPACKED — the
# agent's durable-install path
# ──────────────────────────────────────────────
# Same law as the jcode pin: version and per-arch checksums travel together
# and a mismatch fails the build. The hashes are the ones the OFFICIAL
# first-stage installer (https://nixos.org/nix/install) pins for this
# release — copied from it, verified here unconditionally. The tarball is
# unpacked HERE (the image ships no xz for the agent to depend on) into a
# non-/nix path: anything baked under /nix would be shadowed the moment a
# deployment mounts the agent's durable store there. The agent runs
# `onecli-nix-install` (below) to install FROM this directory, offline —
# no runtime download, no curl-pipe-sh, and no egress-policy dependency.
FROM base AS nix-dist
ARG TARGETARCH
ARG NIX_VERSION=2.35.2
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
    arm64) NIX_SYSTEM="aarch64-linux"; \
      SHA="4d0302a2910f5eec1c33b8deef634f04899a75737e7001ec49908d003ae5efda";; \
    amd64) NIX_SYSTEM="x86_64-linux"; \
      SHA="0c3960a9792331a22081c3c7a5d8465db9b17c50b3acdf18587fa4c6f2cb1158";; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1;; \
  esac \
  && curl -fsSL -o /tmp/nix.tar.xz \
    "https://releases.nixos.org/nix/nix-${NIX_VERSION}/nix-${NIX_VERSION}-${NIX_SYSTEM}.tar.xz" \
  && echo "${SHA}  /tmp/nix.tar.xz" | sha256sum -c - \
  && mkdir -p /opt/nix-dist \
  && tar -xJf /tmp/nix.tar.xz -C /opt/nix-dist \
  && rm /tmp/nix.tar.xz \
  # Known layout only, or fail HERE: one dir, holding the second-stage
  # `install` script and the pre-built store it copies from.
  && [ "$(ls /opt/nix-dist | wc -l)" -eq 1 ] \
  && test -x "/opt/nix-dist/nix-${NIX_VERSION}-${NIX_SYSTEM}/install" \
  && test -d "/opt/nix-dist/nix-${NIX_VERSION}-${NIX_SYSTEM}/store" \
  # Root-owned 0755 like /opt/jcode: readable by the agent, never writable.
  && chown -R root:root /opt/nix-dist \
  && chmod -R a-w,a+rX /opt/nix-dist

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
# Stage 7: Production runner — the app on top of the agent base image
# ──────────────────────────────────────────────
# The OS surface (Debian, the one big apt layer, podman/browser/toolchain
# wiring and their gates, the durable-home passwd + profile.d, the OS-level
# ENV) is docker/agent-base.Dockerfile: built only when THAT file
# changes, so an app change ships only this stage's ~90 MB. The default tag
# is what `pnpm agent:build` builds first; a deployment and publish.yml
# pass a registry reference pinned BY DIGEST (a re-tagged base must never
# change a thin image that did not rebuild). Everything this stage adds is
# ours: the app, the vendored runtime and Nix release, the entrypoint, the
# app-level ENV, and the privilege drop. AGENT_BASE_IMAGE is the global ARG
# at the top of this file.
FROM ${AGENT_BASE_IMAGE} AS runner
# Dual-licensed image contents: Apache-2.0 plus the enterprise-licensed ee/
# paths compiled/bundled into every edition — see LICENSE and
# LICENSE-ENTERPRISE at the repository root.
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"
WORKDIR /app

ENV NODE_ENV=production
ENV NO_COLOR=1
ENV FORCE_COLOR=0
# Telemetry stays off no matter what spawns the supervisor.
ENV JCODE_NO_TELEMETRY=1
# The updater stays off no matter what spawns jcode — the supervisor, a
# docker exec, the agent's own shell. Presence-based upstream: any value
# disables. The supervisor sets it again at launch (belt for non-image runs).
ENV JCODE_NO_AUTO_UPDATE=1

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# Bundles ship sourcemaps; make Node actually use them in stack traces.
ENV NODE_OPTIONS=--enable-source-maps

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
# The pinned Nix release, unpacked, root-owned — the offline source
# `onecli-nix-install` installs from (Stage 4b).
COPY --from=nix-dist /opt/nix-dist /opt/nix-dist
COPY docker/onecli-nix-install /usr/local/bin/onecli-nix-install
RUN chmod 0755 /usr/local/bin/onecli-nix-install
# Drop the npm-bundled v0.67.1 binary so nothing can silently fall back to
# it; the SDK's JS client library stays. Hoisted layout: the platform
# packages sit directly under node_modules/@1jehuang/. Assert the glob
# actually matched (plain ls fails the build on a miss) — a layout change
# must fail HERE, not silently resurrect the stale binary.
RUN ls /app/node_modules/@1jehuang/jcode-linux-*/bin/jcode > /dev/null \
  && rm /app/node_modules/@1jehuang/jcode-linux-*/bin/jcode

COPY docker/agent-entrypoint.sh ./agent-entrypoint.sh
RUN chmod +x ./agent-entrypoint.sh

# The durable home: the container is disposable, this is not.
RUN mkdir -p /workspace && chown node:node /workspace
# The durable-home gate (same law as the jcode/podman gates): prove the
# surface at build time, not at first agent boot. setpriv, never `su -l` —
# su strips the ENV these pins live in, so it would test a different
# environment than production runs. The probe home is removed in this same
# layer and BEFORE the VOLUME line: baked /workspace content would seed
# Docker named volumes while a backend that mounts the home as a block
# device shadows it — a substrate fork.
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
  # The Nix gate. What a build CAN prove: the vendored release is whole and
  # the helper is sound. `sh -n` catches a syntax slip in the POSIX script;
  # the REFUSAL path runs for real — with no /nix mount (a build has none)
  # the helper must exit 2 with the hosted-only note, never install into the
  # rootfs. The install path itself needs a bind mount root can make, so it
  # is proven in the live check, not here.
  && xz --version | head -1 \
  && sh -n /usr/local/bin/onecli-nix-install \
  && sh -n /etc/profile.d/onecli-path.sh \
  && [ "$(ls /opt/nix-dist | wc -l)" -eq 1 ] \
  && test -x /opt/nix-dist/nix-*/install \
  && test -f /etc/onecli/README.nix \
  && setpriv --reuid node --regid node --init-groups sh -c ' \
       export HOME=/workspace/.home; mkdir -p "$HOME"; \
       out=$(onecli-nix-install 2>&1); rc=$?; \
       [ "$rc" -eq 2 ] || { echo "expected refusal (exit 2) without a /nix mount, got $rc: $out" >&2; exit 1; }; \
       echo "$out" | grep -q "self-hosted Docker" || { echo "refusal lacked the hosted-only note: $out" >&2; exit 1; }; \
       test ! -e /nix/store' \
  && rm -rf /workspace/.home
VOLUME ["/workspace"]

USER node

CMD ["./agent-entrypoint.sh"]
