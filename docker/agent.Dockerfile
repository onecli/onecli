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
#   library only (its wire protocol major is 1 on both 0.67.x and 0.71.x);
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
ARG JCODE_VERSION=v0.71.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
    arm64) ASSET="jcode-linux-aarch64"; \
      SHA="bbd3bcd62cf67f89b7923960cda0fd8cc2129f6347d5e9904b7506e46c884d86";; \
    amd64) ASSET="jcode-linux-x86_64"; \
      SHA="fb2af63f1df5aecc6e9185d1f88be5ec634578d30081af7db68486bc8283f76b";; \
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
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini git curl ripgrep ca-certificates openssl e2fsprogs util-linux \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

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
VOLUME ["/workspace"]

USER node

CMD ["./agent-entrypoint.sh"]
