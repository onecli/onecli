# OneCLI gateway — self-host image
# Build context: repo root (run with `docker build -f docker/gateway.Dockerfile .`)

# ──────────────────────────────────────────────
# Stage 1a: Install cargo-chef
# ──────────────────────────────────────────────
FROM rust:1.97-alpine3.24 AS chef
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static \
  && cargo install cargo-chef --version 0.1.78 --locked
WORKDIR /build

# ──────────────────────────────────────────────
# Stage 1b: Prepare dependency recipe
# ──────────────────────────────────────────────
FROM chef AS planner
COPY apps/gateway/ .
RUN cargo chef prepare --recipe-path recipe.json

# ──────────────────────────────────────────────
# Stage 1c: Build Rust gateway
# ──────────────────────────────────────────────
FROM chef AS builder
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY apps/gateway/ .
RUN cargo build --release --locked

# ──────────────────────────────────────────────
# Stage 2: Minimal runtime image
# ──────────────────────────────────────────────
FROM alpine:3.24 AS runner
# Dual-licensed image contents: Apache-2.0 plus the enterprise-licensed ee/
# paths compiled/bundled into every edition — see LICENSE and
# LICENSE-ENTERPRISE at the repository root.
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"
WORKDIR /app

RUN apk add --no-cache ca-certificates

# Build version read by the gateway at runtime (empty → gateway falls back to
# its compile-time crate version).
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

COPY --from=builder /build/target/release/onecli-gateway /usr/local/bin/onecli-gateway

# Data directory for the persisted CA and gateway state (shared read-only with
# the api service in the compose stack, which serves the CA to install flows).
RUN addgroup -S onecli && adduser -S onecli -G onecli && \
    mkdir -p /app/data && chown onecli:onecli /app/data
VOLUME ["/app/data"]

USER onecli

EXPOSE 10255

# The binary probes its own /healthz — no curl/wget needed in the image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["onecli-gateway", "--healthcheck"]

# The gateway is PID 1 and handles SIGTERM itself (graceful shutdown).
ENTRYPOINT ["onecli-gateway"]
CMD ["--port", "10255", "--data-dir", "/app/data"]
