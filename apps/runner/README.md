# `@onecli/runner`

The daemon that gives a hosted agent a computer: it registers with the control
plane, long-polls for work, and starts, parks, and reaps agent sandboxes.

It is **outbound-only** — it holds no ports the outside world can reach, so a
laptop, a homelab, or a VPC behind NAT all work with no ingress, no tunnel, and
no TLS termination story. It also never touches the database: the migrations
one-shot owns migrations, the api every read.

## The shape

```
control plane  ──(runner long-polls: work in, events out)──  runner
                                                               │  docker socket
                                                               ▼
                                                       agent sandbox
                                                     (internal network)
                                                               │
                                                     the gateway, only
```

Three pieces:

- **`backend/`** — the `SandboxBackend` seam. `docker/` is the only place a
  container runtime is named; `fake.ts` is an in-memory implementation the
  whole loop is tested against. A new substrate (Fly, k8s, microVMs) is a new
  module plus one line in `index.ts`.
- **`ws/`** — the control channel a sandbox's supervisor dials, authenticated
  by a single-use bootstrap token minted per spawn.
- **`runner.ts`** — the loop: poll → execute → report, plus the reconcile pass
  that destroys anything the control plane no longer knows about (which is how
  deleting an agent reaches the compute plane).

## Running it locally

`pnpm dev` runs it, along with web, api and the gateway:

```bash
pnpm agent:build   # once — builds the sandbox image the runner spawns
pnpm dev           # web :10254  api :10256  gateway :10255  runner :8484
```

(With Docker off, `pnpm dev` runs everything else and says the runner was
skipped; without the image built, it offers the one-time build right there —
declining still runs everything else.)

The host-shaped settings a non-container runner needs — the advertised host a
sandbox dials back on, a routable sandbox network, the image tag — are built
into the `pnpm dev` launcher as defaults, so your own `.env` still wins. The
dev `RUNNER_TOKEN` is minted once into `.env`, because the api-server and the
runner must present the same value.

`RUNNER_NETWORK_INTERNAL=false` (the launcher's dev default) is a
**development-only** setting:
it lets the sandbox reach a gateway running on the host. In any real deployment
it stays `true` — an `internal` network with the gateway dual-homed onto it is
what makes gateway-only egress a boundary rather than a suggestion.

The runner has no file watcher on purpose. Restarting it makes the control
plane fail every in-flight turn (the sandbox's control channel dies with the
process, and its bootstrap token was single-use), so a save mid-conversation
would end the conversation. Restart it by hand when you change it.

The full-stack version of this (build → up → create a hosted agent → watch it
start) lives in `apps/hosted-e2e` — the black-box suite that spawns a real
gateway, api-server, this runner, and real sandbox containers per test. The hand-run `dev/*.sh` proof scripts
that used to live here were removed: nothing ran them, so four of the six had
silently rotted — the automated suite is the only form of this worth keeping.

## In compose

The runner is the stack's opt-in fifth service. It stays out of a plain
`docker compose up` until the install's `.env` says otherwise:

```
COMPOSE_PROFILES=runner
```

`install.sh` provisions `RUNNER_TOKEN` and `DOCKER_GID` regardless, so
enabling it is that one line.

## Configuration

Every address is configuration with a local default. The ones that matter:

| Variable                      | Default                  | What it does                                          |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| `RUNNER_TOKEN`                | _(required)_             | Its credential, and the registration anchor           |
| `RUNNER_CONTROL_PLANE_URL`    | `http://localhost:10256` | Where it polls                                        |
| `RUNNER_BACKEND`              | `docker`                 | `docker` or `fake` — config, never detection          |
| `RUNNER_AGENT_IMAGE`          | `onecli-agent:dev`       | The sandbox base image                                |
| `RUNNER_SANDBOX_NETWORK`      | `onecli-sandboxes`       | The isolated network sandboxes join                   |
| `RUNNER_NETWORK_INTERNAL`     | `true`                   | `true` = that network has NO route out (dev-only off) |
| `RUNNER_ADVERTISED_HOST`      | `runner`                 | How a sandbox addresses this runner's channel         |
| `RUNNER_MAX_SANDBOXES`        | `4`                      | Concurrency cap, also reported to placement           |
| `RUNNER_RECONCILE_SECONDS`    | `60`                     | How often orphans are reaped                          |
| `RUNNER_ORPHAN_REAP`          | `true`                   | The stale-label sweep (below); `false` = log only     |
| `RUNNER_ORPHAN_GRACE_SECONDS` | `3600`                   | Minimum age before a stale-label object may be reaped |

Sandbox resource limits: `RUNNER_SANDBOX_MEMORY_MB` (2048),
`RUNNER_SANDBOX_CPUS` (1), `RUNNER_SANDBOX_PIDS` (512). On plain Linux, where
`host.docker.internal` does not resolve inside a container,
`RUNNER_SANDBOX_EXTRA_HOSTS=host.docker.internal:host-gateway` adds it to every
sandbox's `/etc/hosts` (dev setups where the gateway runs on the host).

## Sizing

A sandbox is a real container with real limits, so a host's ceiling is
arithmetic, not vibes:

```
RUNNER_MAX_SANDBOXES × RUNNER_SANDBOX_MEMORY_MB  +  the base stack
```

The default 4 × 2 GiB means a host should have **~10 GiB free** beyond
postgres, the gateway, the api, and the web app before raising the cap. CPU is
softer (1 vCPU per sandbox is a share, not a reservation), and each home
volume grows with whatever the agent keeps on disk.

**Held-awake boxes are the number to respect.** A sandbox observing live
background work — a running process, an armed watch — never parks, so it holds
its slot _permanently_, not just at peak: size `RUNNER_MAX_SANDBOXES` to what
the host can hold **all the time**, not to peak concurrency. The platform
bounds this with a per-runner ceiling — `max(1, RUNNER_MAX_SANDBOXES − 1)` by
default, overridable with `MAX_HELD_AWAKE_SANDBOXES` on the api — evicting the
longest-idle held box over the ceiling (its watches report "the process was
lost" honestly), so background work can never wedge the whole host. Operators
can read the per-runner count beside the ceiling on `GET /v1/runners`.

## Nested containers (podman) in the sandbox

The sandbox image ships rootless podman and a `docker` CLI shim
(`podman-docker`) so agents can run `docker run`-class work — a capability of
the **hosted microVM substrate**, where every sandbox owns a whole kernel.
Under this runner's Docker backend the same binaries are intentionally inert:
every sandbox is pinned with `no-new-privileges`, `CapDrop: ALL`, and the
Docker daemon's **default seccomp profile**, which together deny the
user-namespace setup rootless containers need on a **shared** kernel
(`CapDrop: ALL` removes `CAP_SYS_ADMIN`, so the default seccomp profile keeps
blocking `unshare`/`clone` with the namespace flags, and `no-new-privileges`
neuters the setuid `newuidmap`/`newgidmap` helpers). That combination is the
tenant boundary here — **do not weaken any of it** (in particular, never add
`seccomp=unconfined`) to chase nested containers; an agent that tries will see
userns/permission errors, and `/etc/containers/README.onecli` inside the image
says why. On the microVM substrate, container storage lives under `/workspace`
(the durable home), so images and volumes survive sandbox restarts there.

## Orphan reaping

Reconcile destroys anything **this** runner's label owns that the control
plane no longer knows — that is how deleting an agent reaches the compute
plane. Objects labeled by a runner id that no longer exists (a control-plane
database reset, a rotated runner registration) are invisible to that loop, so
a second sweep handles them: every container and volume **this installation**
created whose sandbox id exists **nowhere** in the control plane, and which is
older than `RUNNER_ORPHAN_GRACE_SECONDS`, is removed. The control plane is
asked first and any failure aborts the sweep with zero destruction;
`RUNNER_ORPHAN_REAP=false` turns it into detection-and-logging only.

The sweep is **safe on a shared Docker daemon**: every object is stamped with
an installation fingerprint (a hash of the runner token — stable across a
database reset, different per install), and the sweep only ever reaps objects
bearing its own. Two OneCLI installs on one host, or the e2e suite running
beside a live dev stack, never touch each other's containers or volumes.

## Tests

`pnpm --filter @onecli/runner test` — the whole loop runs against the fake
backend and a recording HTTP transport, so no daemon, image, or privilege is
needed.
