# OneCLI web (dashboard) — self-host image
# Build context: repo root (run with `docker build -f docker/web.Dockerfile .`)

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to web + db packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/web --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
# Skip @prisma/client's postinstall generate: no schema exists in this stage
# (the client is generated explicitly below). Prisma 7 removes this env var.
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Build Next.js app
# ──────────────────────────────────────────────
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1

# App version stamped into the web build (next.config.js reads APP_VERSION; falls
# back to the root package.json version when unset).
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @onecli/db generate
# Dummy DATABASE_URL satisfies Prisma during static page generation
RUN --mount=type=cache,target=/app/apps/web/.next/cache \
    DATABASE_URL="postgresql://build:build@localhost/build" \
    pnpm build --filter=@onecli/web

# ──────────────────────────────────────────────
# Stage 5: Production runner
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS runner
# Dual-licensed image contents: Apache-2.0 plus the enterprise-licensed ee/
# paths compiled/bundled into every edition — see LICENSE and
# LICENSE-ENTERPRISE at the repository root.
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"
WORKDIR /app

# tini as PID 1: Node is not an init (signal handling differs, orphans are
# never reaped). See
# https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#handling-kernel-signals
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NO_COLOR=1
ENV FORCE_COLOR=0
ENV PORT=10254
ENV HOSTNAME="0.0.0.0"

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# Next.js standalone output
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node

EXPOSE 10254

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:10254/healthz || exit 1

CMD ["node", "apps/web/server.js"]
