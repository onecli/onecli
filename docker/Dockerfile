# OneCLI — all-in-one Docker image (proxy + web + PGlite)
# Build context: repo root (run with `docker build -f docker/Dockerfile .`)

# ──────────────────────────────────────────────
# Stage 1a: Install cargo-chef
# ──────────────────────────────────────────────
FROM rust:1-alpine AS chef
RUN apk add --no-cache musl-dev && cargo install cargo-chef
WORKDIR /build

# ──────────────────────────────────────────────
# Stage 1b: Prepare dependency recipe
# ──────────────────────────────────────────────
FROM chef AS planner
COPY apps/proxy/ .
RUN cargo chef prepare --recipe-path recipe.json

# ──────────────────────────────────────────────
# Stage 1c: Build Rust proxy
# ──────────────────────────────────────────────
FROM chef AS proxy-builder
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY apps/proxy/ .
RUN cargo build --release

# ──────────────────────────────────────────────
# Stage 2: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 3: Prune monorepo to web + db packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @onecli/web --docker

# ──────────────────────────────────────────────
# Stage 4: Install dependencies
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 5: Build Next.js app
# ──────────────────────────────────────────────
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @onecli/db generate
# Dummy DATABASE_URL prevents PGlite from initializing during static page generation
RUN --mount=type=cache,target=/app/apps/web/.next/cache \
    DATABASE_URL="postgresql://build:build@localhost/build" \
    pnpm build --filter=@onecli/web

# ──────────────────────────────────────────────
# Stage 6: Production runner
# ──────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NO_COLOR=1
ENV FORCE_COLOR=0
ENV PORT=10254
ENV HOSTNAME="0.0.0.0"
ENV AUTH_TRUST_HOST=true
ENV NEXTAUTH_URL=http://localhost:10254

# Proxy binary from Rust build
COPY --from=proxy-builder /build/target/release/onecli-proxy /usr/local/bin/onecli-proxy

# Next.js standalone output
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

# Prisma migrations and init script for PGlite mode
COPY --from=builder --chown=node:node /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder --chown=node:node /app/packages/db/scripts ./packages/db/scripts

# PGlite dependencies for embedded DB mode
RUN cd packages/db && npm init -y > /dev/null 2>&1 && \
    npm install @electric-sql/pglite@0.3.15 prisma@6

# Entrypoint
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Data directory for CA certs, proxy secret, PGlite data
RUN mkdir -p /app/data && chown node:node /app/data
# PGlite uses relative "./data/pglite" from server.js at apps/web/server.js,
# which resolves to /app/apps/web/data/. Symlink it to the volume mount.
RUN mkdir -p /app/apps/web && ln -s /app/data /app/apps/web/data
VOLUME ["/app/data"]

USER node

EXPOSE 10254 10255

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:10254/api/health && wget -qO- http://localhost:10255/healthz || exit 1

CMD ["./entrypoint.sh"]
