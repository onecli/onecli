# OneCLI channel adapter — the provider-connection daemon (channels, step 6)
# Build context: repo root (`docker build -f docker/channel-adapter.Dockerfile .`)
#
# Holds outbound Slack connections (Socket Mode), renders agents' answers
# back into provider threads, mirrors web exchanges, and posts approval
# cards. An outbound-only /v1 API client: no published ports, no database,
# no docker socket — the runner's shape minus everything compute.
#
# Its egress goes DIRECTLY to Slack on purpose: platform traffic, not agent
# traffic — never through the gateway, never on the sandboxes network.

# ──────────────────────────────────────────────
# Stage 1: Prepare Node.js base
# ──────────────────────────────────────────────
FROM node:22.23.2-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Prune monorepo to the adapter's packages
# ──────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.11 prune @onecli/channel-adapter --docker

# ──────────────────────────────────────────────
# Stage 3: Install dependencies (dev deps included — the build needs them)
# ──────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────
# Stage 4: Build — bundle the adapter to dist/
# ──────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm build --filter=@onecli/channel-adapter

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
# Stage 6: Production image
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
# never rewrite it. The adapter is an outbound-only client with no local state.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/channel-adapter/dist ./apps/channel-adapter/dist

USER node

CMD ["node", "apps/channel-adapter/dist/index.mjs"]
