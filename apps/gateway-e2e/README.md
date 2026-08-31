# @onecli/gateway-e2e

Black-box end-to-end tests for the OneCLI gateway.

These tests **spawn the real `onecli-gateway` binary** as a child process and drive it over
the wire as a proxy client. They import nothing from the gateway crate and assert only on
externally observable behavior — status lines, headers, response bodies, and what a stub
upstream actually received.

That is deliberate. The gateway is being restructured into a workspace of crates, which will
move essentially every file in it. A suite coupled to internals would break during that move
and protect nothing; a suite that only knows the wire protocol survives it and is exactly the
regression net the restructure needs.

## The edition model: enterprise by default, arms per lane

The binary is edition-less; the runtime env selects behavior. The suite's default spawn env
is the **enterprise edition** — an entitled self-host (`EDITION=onprem` +
`ENTERPRISE_ENABLED=true`) running the **licensed Redis-backed HA stores** (`REDIS_HOST`
set) and the local AES crypto backend (`SECRET_ENCRYPTION_KEY`, pinned by
`vitest.config.ts`). That is the canonical licensed deployment, and it exercises the
entitled feature set (group principals, resource scoping, budgets, RBAC rechecks, HA
stores) that a plain self-host never runs.

Two lanes override it per test:

- **The unlicensed lane** (`unlicensed.test.ts`) blanks `ENTERPRISE_ENABLED` and
  `REDIS_HOST` and proves the decided flag-off posture from the outside — licensed features
  get a differential twin (same seeds, opposite outcome), free surfaces get parity twins.
- **The cloud lane** (`platform-llm.test.ts`) sets `EDITION=cloud` and covers cloud-only
  wire behavior: the platform Anthropic trial credit and the cloud boot posture. The
  Cognito/KMS values it sets are dummies satisfying the cloud fail-fast — never dialed
  (sessions stay on agent tokens; the pinned `SECRET_ENCRYPTION_KEY` selects local AES by
  config precedence). The KMS envelope FORMAT itself is unit-pinned on both sides of the
  TS↔Rust contract (`packages/api/src/ee/kms-crypto.contract.test.ts`,
  `apps/gateway/crates/ee/ee/src/kms_crypto.rs`); only the live AWS KMS call is proven by deploys.

## Running locally

Two containers, then migrate, then run. Use `127.0.0.1` throughout, never `localhost`:
Node 17+ resolves `localhost` with `verbatim` DNS ordering and can answer `::1` first, which
fails to connect while other clients on the same host succeed.

```bash
# 1. Postgres. max_connections is raised because every test holds its own gateway
#    pool (up to 5) plus a Prisma client.
docker run -d --name gwe2e-db -p 5434:5432 \
  -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=onecli \
  postgres:18-alpine -c max_connections=200

# 2. Redis — the enterprise lane runs the licensed Redis-backed stores.
docker run -d --name gwe2e-redis -p 6379:6379 redis:7-alpine

# 3. Create and migrate the template database the tests clone per test.
docker exec gwe2e-db psql -U ci -d onecli -c 'CREATE DATABASE onecli_e2e_template'
DATABASE_URL=postgresql://ci:ci@127.0.0.1:5434/onecli_e2e_template \
  pnpm --filter @onecli/db exec prisma migrate deploy

# 4. Run. `test:e2e` builds the gateway binary first; use `test:e2e:no-build`
#    to skip that when the binary is already current.
#
#    The script is deliberately NOT called `test`: the root `pnpm test` runs
#    `turbo run test`, and this suite must not drag containers and a cargo build
#    into everyone's default test command.
export E2E_ADMIN_DATABASE_URL=postgresql://ci:ci@127.0.0.1:5434/postgres
export E2E_TEMPLATE_DB=onecli_e2e_template
export E2E_REDIS_HOST=127.0.0.1
pnpm --filter @onecli/gateway-e2e test:e2e
```

Teardown: `docker rm -f gwe2e-db gwe2e-redis`.

## Isolation

Two mechanisms, and both are required.

**Per-test databases** isolate schema and rows. `globalSetup` migrates a template once and
then freezes it with `ALLOW_CONNECTIONS false`, so no session can block a clone and no test
can mutate the source of truth. Each test clones it with `CREATE DATABASE … TEMPLATE …`.

**Per-test unique ids** isolate Redis, which per-test databases do _not_. Redis is a single
shared instance and is never flushed between tests. The gateway keys its connect cache as
`connect:{org}:{workspace}:{token}:{host}` with a 60-second TTL, and its rate-limit counters as
`rate:{org}:{workspace}:{rule}:{token}:{window}` — so distinct org/workspace/agent ids are the
only thing separating one test's cached state from another's. Every id derives from a
per-test nonce, and the fixture builder deliberately exposes no way to pin one. A fresh nonce
per run also means a re-run never inherits its own still-live cache entries.

## What it covers, and what it deliberately does not

Every test asserts externally observable behavior only — a status line, a header, a JSON
body, or what the stub upstream actually received. That is what lets the suite survive having
every file underneath it moved.

Two properties are worth calling out because nothing else in the repo guards them, and both
fail **open** — a regression in either is silent, and every other test stays green:

- **`has_injections`** (`src/gateway/forward.rs`) feeds the deny-by-default carve. If it goes
  false, every Default-Rule Block stops enforcing. Pinned by the pair in `policy.test.ts` — same
  org default rule, granted credential present vs absent.
- **Grant-driven injection** (attach-model step 7): nothing from the org/workspace tiers injects
  without a published allow rule naming the agent (the legacy `agents.secret_mode` column is
  dropped outright). Pinned by `grants.test.ts`. The silent-vacuity trap inverted with step 7:
  a world that seeds credentials but forgets `grantAll` (or granting rules) makes every
  injection assertion pass against a gateway that injects nothing at all — say `grantAll`.
- **`needs_body_buffer`** (`policy_engine/enforce.rs`) feeds body buffering. If the body
  is not buffered, a `body contains` block rule sees `None` and never matches. Pinned by the
  pair in `policy.test.ts` — same rule, body with and without the value.

The Rust corpus tests already pin the _evaluator's_ semantics against a `PolicyRequest`. What
they cannot see is whether the gateway populates that request correctly, which is precisely
what these two pairs assert.

Known gaps, all deliberate:

- **No WebSocket idle timeout.** `WS_IDLE_TIMEOUT` is ten minutes and is not configurable, so
  covering it would mean either a ten-minute test or a knob added purely for the test. The
  rest of the WebSocket surface — the handshake, header filtering, credential injection,
  bidirectional piping and the non-101 passthrough — is covered against a live stub.
- **No provider-catalog host logic.** Fixtures use generic secrets on `127.0.0.1`, so the
  catalog's host-coverage rules are not exercised.
- **No app-connection injection reaching an upstream.** Provider hosts cannot be redirected to
  a local stub — no `host_rewrite` is set by any provider, and the HTTP client installs no DNS
  override — so asserting an OAuth credential _arrived_ would need real egress. The
  resolution outcomes (ambiguity, not-found) are covered instead, since they answer before any
  socket opens.
- **No approval timeout.** It is 180 seconds.
- **No live KMS decryption.** The KMS backend is hosted-cloud plumbing; its envelope format
  is unit-pinned cross-language (see above), and the live AWS round-trip is proven by cloud
  deploys, not this suite.

Tests that name a real provider hostname (`gmail.googleapis.com`) still make no network calls:
they assert an arm that answers before egress. Where a test needs a host that must _never_
resolve even if that changed, it uses `.invalid`.

## Shutdown tests

`shutdown.test.ts` drives the real SIGTERM/SIGINT path, so it uses
`gw.terminate()` rather than `stop()`. The distinction matters:

- **`stop()` is a fast kill** — SIGTERM, a 250 ms grace, then SIGKILL. It is what
  teardown uses on every scenario, and it deliberately does not wait for a
  drain: 70+ gateways each paying seconds of drain would dominate the suite.
- **`terminate()` observes the drain** — it resolves on the child's `close`
  event with `{code, signal, durationMs}`, so a test can assert the process
  exited itself (`code 0`, `signal null`) rather than being killed, and how long
  it took.

Tests can shorten the drain with `GATEWAY_SHUTDOWN_TIMEOUT_SECS` (default 5s)
via `startGateway({ env: … })`.

## Debugging a failure

Set `GATEWAY_E2E_KEEP_DB=1` to skip the per-test `DROP DATABASE` and print the connection
URL, so you can inspect the exact state a test left behind.

The gateway's captured stdout and stderr are attached to failures. It runs with
`LOG_FORMAT=json`, so those lines are structured and greppable.

## The one coupling to the gateway

The suite imports no gateway code, but it does read a few things out of the
gateway's **structured log**: the `starting onecli-gateway` line (to confirm the
binary really booted the edition the test meant to start), the `listening for
connections` line's `addr` field (to discover the port chosen by `--port 0`),
and — in `shutdown.test.ts` only — the `shutdown started` and `drain complete`
messages, which pin that a signal starts a real drain rather than the process
merely dying. It runs the child with `LOG_FORMAT=json` for exactly this reason.

That is the whole interface. Renaming any of these messages, dropping the `addr`
field, or changing the `edition` value will break the suite in a way that looks
nothing like the cause — so if you touch those log lines, run this suite.
