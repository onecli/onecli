# OneCLI SSH terminator — the sandbox platform's SSH front door (hosted agents)
# Build context: repo root (run with `docker build -f docker/ssh-terminator.Dockerfile .`)
#
# It terminates ssh with the short-lived certificates the api mints and bridges
# each session into an agent's container via the Docker Engine API on the host
# socket, so the socket must be mounted and its group granted at RUN time (see
# docker-compose.yml). Nothing here needs root: the process runs as `node` and
# reaches the socket via `group_add`.
#
# It carries NO database client — it speaks the /v1/ssh-terminator surface over
# HTTP and reaches the daemon over the socket; the api owns every DB read.

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to the terminator's packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/ssh-terminator --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (dev deps included — the build needs them)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Build — bundle the terminator to dist/
# ──────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm build --filter=@onecli/ssh-terminator

# ──────────────────────────────────────────────
# Stage 5: Production node_modules — hoisted (npm-style flat) so the bundle's
# externalized imports (ssh2, undici) resolve from /app/node_modules.
# ──────────────────────────────────────────────
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ .
RUN echo "node-linker=hoisted" >> .npmrc \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

# ──────────────────────────────────────────────
# Stage 6: Production runner
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS runner
# The terminator is pure Apache-2.0 — no ee/ code lives in this app.
LABEL org.opencontainers.image.licenses="Apache-2.0"
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

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/ssh-terminator/dist ./apps/ssh-terminator/dist

USER node

# The ssh listener (published to the host) and the health listener (probed
# by compose / an LB; never internet-facing).
EXPOSE 2222 8091

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8091/healthz || exit 1

CMD ["node", "apps/ssh-terminator/dist/index.mjs"]
