# hosted-e2e

Black-box end-to-end suite for the **hosted-agents path** — the step-13
companion to `apps/gateway-e2e`, and the automated replacement for the
hand-run `apps/runner/dev/*.sh` proof scripts (deleted after four of six
silently rotted).

Per test (`pnpm --filter @onecli/hosted-e2e test:e2e`): a private Postgres
database cloned from a migrated template, a spawned **gateway binary**
(the enterprise edition — an entitled self-host, `EDITION=onprem` +
`ENTERPRISE_ENABLED=true`, local AES; give it the licensed Redis-backed HA
stores by setting `E2E_REDIS_HOST`, as CI does — without it the entitled
in-memory stores run, also a legitimate licensed configuration), a spawned
**api-server** child (same edition), an **in-process runner** with the real
Docker backend, and **real sandbox containers** from the agent image running
the fake harness. Covers
the spine (spawn → turn → platform tool call → gateway injection → approval
hold → sleep → wake → cron fire) plus the hardening legs: multi-tenant
isolation, kill-mid-turn recovery, runner restart, memory write-back
durability, mid-run steering, the held-awake ceiling, the stale-label orphan
sweep, and the §3.13 auto-hide posture.

(A second, compose-smoke lane — booting the shipped compose file + images and
probing the `internal: true` network — existed until 2026-08-12 and was
removed by decision: packaging-level coverage was not worth its CI cost. The
gateway's untokened-407 posture stays pinned in `apps/gateway-e2e`
`auth.test.ts`; the runner's fail-closed non-internal-network refusal stays
pinned in `tests/orphan-reap.test.ts`.)

## Running the suite

```bash
# One-time infrastructure: a Postgres to clone from, the agent image, the gateway binary.
docker run -d --name he2e-pg -e POSTGRES_PASSWORD=postgres -p 5461:5432 postgres:18-alpine
docker exec he2e-pg psql -U postgres -c 'CREATE DATABASE onecli_he2e_template'
DATABASE_URL=postgresql://postgres:postgres@localhost:5461/onecli_he2e_template \
  pnpm --filter @onecli/db exec prisma migrate deploy
docker build -f docker/agent.Dockerfile -t onecli-agent:he2e .
cargo build --manifest-path apps/gateway/Cargo.toml --bin onecli-gateway

E2E_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5461/postgres \
E2E_TEMPLATE_DB=onecli_he2e_template \
E2E_AGENT_IMAGE=onecli-agent:he2e \
  pnpm --filter @onecli/hosted-e2e test:e2e:no-build
```

Unset variables **skip locally and throw in CI** — the gateway-e2e law: a
silently-skipping proof suite is exactly the rot this package replaces.

## The three laws worth knowing before writing a scenario

1. **Door 2 is seeded from day one.** A sandbox will not start without a
   stored LLM secret **and** a published grant rule naming the agent
   (`seedAnthropicGrant`). Forget the grant and every spawn parks — a suite
   asserting absence stays green while proving nothing.
2. **Hosted agents are fixture-seeded, never API-created.** That pins
   `Sandbox.id` to the `he2e-` prefix, which is what makes every Docker
   object a killed run leaves behind sweepable **by name** at the next
   globalSetup without ever touching a developer's real stack (whose sandbox
   ids are cuids).
3. **Turn shape is scripted from outside** via the fake harness's `@fake:v1`
   directive (`src/fake-dsl.ts`): long runs for steering runway, an HTTP call
   that transits the gateway from inside the sandbox (the injection/approval
   witness), platform-tool dials, scripted deaths. Non-directive messages take
   the fake's default echo path.

## Isolation model

Per test: a nonce-derived id set (`src/ids.ts`), a cloned database, a
dedicated sandbox network (`oce2e-<nonce>`), a fresh runner registration
(fresh runner id → the docker backend's owner label isolates parallel tests
on one daemon). Teardown reaps runner sandboxes + homes explicitly
(`runner.stop()` deliberately leaves them, like production), then the
children, then the network, then — unconditionally — the database.
