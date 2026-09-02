# OneCLI runner — the sandbox lifecycle daemon (hosted agents)
# Build context: repo root (run with `docker build -f docker/runner.Dockerfile .`)
#
# The runner spawns agent sandboxes through the Docker Engine API on the host's
# socket, so the socket must be mounted and its group granted at RUN time (see
# docker-compose.yml). Nothing here needs root: the process runs as `node` and
# reaches the socket via `group_add`.
#
# It deliberately carries NO database client — the migrations one-shot owns
# migrations, the api every DB read; the runner is an outbound-only API
# client (§3.3).

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to the runner's packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/runner --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (dev deps included — the build needs them)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Build — bundle the runner to dist/
# ──────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm build --filter=@onecli/runner

# ──────────────────────────────────────────────
# Stage 5: Production node_modules — hoisted (npm-style flat) so the bundle's
# externalized imports resolve from /app/node_modules. Prod-only.
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
# Stage 6: Production runner
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS runner
# Dual-licensed image contents: Apache-2.0 plus the enterprise-licensed ee/
# paths compiled/bundled into every edition — see LICENSE and
# LICENSE-ENTERPRISE at the repository root.
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"
WORKDIR /app

# tini as PID 1: Node is not an init (signal handling differs, orphans are
# never reaped).
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

ENV NODE_ENV=production
ENV NO_COLOR=1
ENV FORCE_COLOR=0

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# Bundles ship sourcemaps; make Node actually use them in stack traces.
ENV NODE_OPTIONS=--enable-source-maps

# Root-owned on purpose: the runtime user (`node`) must execute this tree,
# never rewrite it. The runner writes only through the Docker socket and its
# outbound API client.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/runner/dist ./apps/runner/dist

USER node

# The control channel the sandboxes dial. Not published to the host: it is
# reachable only on the container networks (§3.3 — no inbound ports).
EXPOSE 8484

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8484/healthz || exit 1

CMD ["node", "apps/runner/dist/index.mjs"]
