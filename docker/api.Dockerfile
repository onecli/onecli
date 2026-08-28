# OneCLI api-server — self-host image
# Build context: repo root (run with `docker build -f docker/api.Dockerfile .`)
#
# Serving image only: migrations live in the dedicated one-shot image
# (docker/migrations.Dockerfile) — the compose `migrations` service runs them
# to completion before this container starts.

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to api-server's packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/api-server --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (dev deps included — the build needs them)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
# Skip @prisma/client's postinstall generate: no schema exists in this stage
# (the client is generated explicitly below). Prisma 7 removes this env var.
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Build — generate the Prisma client, bundle the server to dist/
# ──────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @onecli/db generate
RUN pnpm build --filter=@onecli/api-server

# ──────────────────────────────────────────────
# Stage 5: Production node_modules — hoisted (npm-style flat) so the bundle's
# externalized imports (deps of the inlined @onecli/* packages) resolve from
# /app/node_modules. Prod-only: no compilers, no test tools, no TS.
# ──────────────────────────────────────────────
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ .
# Append to the repo .npmrc (turbo prune carries it, and its settings must
# stay visible or the frozen-lockfile check rejects the install).
# --ignore-scripts: the root `prepare` hook (husky) is a dev tool absent from
# a --prod install, and no production dependency needs a lifecycle script —
# the Prisma client is generated explicitly right after.
RUN echo "node-linker=hoisted" >> .npmrc \
  && pnpm install --prod --frozen-lockfile --ignore-scripts
# The Prisma schema, copied AFTER the install layer so a new migration file
# never busts the expensive install cache; generate needs it to produce the
# runtime client (.prisma/client + engine) inside this node_modules.
COPY --from=pruner /app/out/full/packages/db/prisma ./packages/db/prisma
RUN pnpm --filter @onecli/db generate

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

# NODE_ENV=production is load-bearing beyond convention: the pino loggers fall
# back to the pino-pretty transport (a dev dependency, absent here) on any
# other value.
ENV NODE_ENV=production
ENV NO_COLOR=1
ENV FORCE_COLOR=0
ENV PORT=10256

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# Bundles ship sourcemaps; make Node actually use them in stack traces.
ENV NODE_OPTIONS=--enable-source-maps

# Root-owned on purpose: the runtime user (`node`) must execute this tree,
# never rewrite it. The server writes only to the DB and /app/data mounts.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/api-server/dist ./apps/api-server/dist

USER node

EXPOSE 10256

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:10256/v1/health || exit 1

CMD ["node", "apps/api-server/dist/index.mjs"]
