# Developing OneCLI

## Prerequisites

- **[mise](https://mise.jdx.dev)** (installs Node.js, pnpm, and other tools)
- **Rust** (for the gateway)
- **Docker** (for PostgreSQL and agent sandboxes)

## Setup

```bash
mise install
pnpm install
pnpm dev
```

That's the whole setup. `pnpm dev` creates `.env` if you don't have one,
generates every required secret into it (never touching a value you set),
starts PostgreSQL, applies migrations, generates the Prisma client, and runs
web, api, gateway and the runner as host processes. Dashboard at
**http://localhost:10254**, gateway at **http://localhost:10255**.

It adapts to your machine. Docker down? Everything except the runner starts,
and it says so. Agent sandbox image not built? It offers to build it on the
spot (one-time, ~3 min) — decline and everything except hosted agents still
starts, with `pnpm agent:build` there whenever you want them.

For a **hosted agent** the order matters: store a model key, **grant it to the
agent**, then chat. A sandbox will not start without a granted key — the agent
says so in the thread.

## Commands

| Command                            | Description                                                     |
| ---------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                         | The whole stack from one command (creates + tops up `.env`)     |
| `pnpm dev -- --filter=@onecli/web` | Just one service (any turbo filter works)                       |
| `pnpm run setup`                   | Self-host install wizard (Docker Compose)                       |
| `pnpm agent:build`                 | Build the agent sandbox image (once, enables hosted agents)     |
| `pnpm build`                       | Production build                                                |
| `pnpm check`                       | Lint + types + format + script tests (the pre-push gate and CI) |
| `pnpm test`                        | Run the test suites                                             |
| `pnpm db:up`                       | Start PostgreSQL (Docker) — `pnpm dev` does this for you        |
| `pnpm db:down`                     | Stop PostgreSQL                                                 |
| `pnpm db:generate`                 | Generate Prisma client                                          |
| `pnpm db:migrate`                  | Run database migrations                                         |
| `pnpm db:studio`                   | Open Prisma Studio                                              |

## Project structure

```
apps/
  web/                # Next.js dashboard (port 10254)
  api-server/         # Hono API server (/v1, port 10256)
  gateway/            # Rust gateway (credential injection, port 10255)
  runner/             # Hosted-agents daemon: starts/parks/reaps sandboxes
  sandbox-supervisor/ # Runs inside each agent sandbox
  ssh-terminator/     # SSH front door: terminates ssh, bridges into sandboxes
  channel-adapter/    # Slack channels daemon
  gateway-e2e/        # Gateway end-to-end suite
  hosted-e2e/         # Hosted-agent end-to-end suite
packages/
  api/                # Shared API package (routes + services)
  agent-protocol/     # Vendor-neutral harness interface
  db/                 # Prisma ORM + migrations
  ui/                 # Shared UI components (shadcn/ui)
scripts/
  dev.mjs             # The `pnpm dev` launcher
  setup/              # The `pnpm run setup` wizard
  install.sh          # The curl | sh installer
docker/
  web.Dockerfile              # Dashboard image
  api.Dockerfile              # API image
  migrations.Dockerfile       # One-shot migration runner (prisma CLI + migrations)
  gateway.Dockerfile          # Gateway image
  runner.Dockerfile           # Runner image
  agent.Dockerfile            # Agent sandbox image
  channel-adapter.Dockerfile  # Slack adapter image
  docker-compose.yml          # The self-host stack
  docker-compose.build.yml    # Build-from-source overlay
  docker-compose.dev.yml      # Dev postgres only (`pnpm db:up`)
```

## Configuration

See [self-hosting.md](self-hosting.md#configuration) for the environment
variable reference. Every required value is generated for you.
