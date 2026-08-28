# OneCLI migrations — dedicated one-shot image, both editions
# Build context: repo root (run with `docker build -f docker/migrations.Dockerfile .`)
#
# Carries exactly what a migration run needs — the lockfile-pinned Prisma CLI,
# packages/db/prisma (schema + migrations), and docker/migrate.sh — and nothing
# else. The compose `migrations` service (self-host) and the cloud migration
# Fargate task both run this image with its default CMD; the serving images
# contain no migration tooling. One ONECLI_VERSION / image tag pins it in
# lockstep with the services, so the migrations that run are always the ones
# the code beside them expects.

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to the db package
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/db --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (Prisma CLI via the lockfile)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
# Skip @prisma/client's postinstall generate: no schema exists in this stage,
# and `migrate deploy` never needs the client. Prisma 7 removes this env var.
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Runner
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS runner
# Only packages/db ships here — Apache-2.0, no enterprise-licensed ee/ paths
# (unlike the serving images).
LABEL org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

# node_modules first (pnpm store + symlinks), then the pruned sources on top —
# prisma lands at /app/packages/db/node_modules/prisma and the schema at
# /app/packages/db/prisma, the exact paths migrate.sh defaults to.
# Root-owned on purpose: the runtime user (`node`) executes this tree, never
# rewrites it — migrate deploy writes only to the database.
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .

# The migration runner is the image's whole job; the canary fails the build if
# the Prisma CLI ever falls out of the pruned workspace install.
COPY docker/migrate.sh ./migrate.sh
RUN chmod +x ./migrate.sh \
  && node packages/db/node_modules/prisma/build/index.js --version > /dev/null

USER node

CMD ["./migrate.sh"]
