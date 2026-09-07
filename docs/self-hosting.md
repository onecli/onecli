# Self-hosting OneCLI

The [README Quick Start](../README.md#quick-start) covers the interactive
setup. This page holds everything else you need to run OneCLI yourself: the
install script, raw compose, version pinning, registration rules, and
upgrade notes.

## Install script

No Node toolchain handy? The install script does the same as `pnpm run setup`
without a clone, writing its configuration to `~/.onecli/.env`:

```bash
curl -fsSL https://onecli.sh/install | sh
```

## Raw Docker Compose

Put the three required secrets in `docker/.env` — **beside the compose
file**, which is where compose reads them — then bring it up:

```bash
git clone https://github.com/onecli/onecli.git && cd onecli/docker
cat > .env <<EOF
SECRET_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
GATEWAY_INTERNAL_SECRET=$(head -c 32 /dev/urandom | base64)
BETTER_AUTH_SECRET=$(head -c 32 /dev/urandom | base64)
COMPOSE_PROFILES=runner
EOF
chmod 600 .env
docker compose up -d --wait
```

Open **http://localhost:10254**, create your account, then create an agent,
store a model key, grant it to the agent, and start talking. (Keep
`SECRET_ENCRYPTION_KEY` safe — it encrypts your stored secrets.)

## Upgrading

Re-run the front door you installed with. Both refresh every image and then
restart your running agent sandboxes so they come back on the new one:

```bash
# Installed with the one-liner:
curl -fsSL https://onecli.sh/install | sh

# Installed from a checkout (the wizard runs what your working tree contains,
# so update it first):
git pull && pnpm install && pnpm run setup --upgrade
```

**Do not upgrade with a bare `docker compose pull && docker compose up -d`.**
It will leave you on a stale agent sandbox image, silently. That image is not
a compose service — it is one environment value on the `runner` service
(`RUNNER_AGENT_IMAGE`) — so `docker compose pull` cannot see it, and the runner
only fetches it when it is missing from the host entirely. The result is a
stack whose dashboard, API and gateway have moved forward while every hosted
agent still boots the old sandbox image, with nothing reporting the mismatch.
The two commands above pull it explicitly; nothing else does.

Restarting a sandbox interrupts whatever that agent was doing: the in-flight
turn reports that the agent restarted, and you send it again. Nothing else is
lost — each agent's `/workspace` lives on its own durable volume, which is
never touched. To upgrade the images but leave running agents alone, set
`ONECLI_KEEP_SANDBOXES=1`; they keep the old image until they next restart.
Put it in your `.env`, or export it — note that in the piped form a variable
written in front of `curl` binds to `curl`, not to the script:

```bash
export ONECLI_KEEP_SANDBOXES=1
curl -fsSL https://onecli.sh/install | sh

ONECLI_KEEP_SANDBOXES=1 pnpm run setup --upgrade   # prefix is fine here
```

## Pinning versions

Every service image defaults to `:latest`, and re-running either front door
moves an unpinned install to the newest published images. For anything you
intend to keep running, pin one release in the same `.env` —
`ONECLI_VERSION=2.0.0` pins all services at once (bare semver, no `v` prefix:
that is how the images are tagged), and the agent sandbox image ref follows it
(`ghcr.io/onecli/onecli-agent:$ONECLI_VERSION`) unless you point
`RUNNER_AGENT_IMAGE` somewhere else. Neither front door ever writes or changes
`ONECLI_VERSION` for you.

Where the two doors differ, and it matters: `pnpm run setup` reads the pin from
`docker/.env` and honors it. The install script instead exports
`ONECLI_VERSION=latest` for its own run, and an exported value beats the `.env`
file in Compose interpolation — so an `.env`-only pin does **not** survive
`curl … | sh`, and re-running it would move a pinned install (including the
`migrations` image, which rolls the schema forward irreversibly). A pinned
install has two safe upgrade routes:

```bash
# Move the pin deliberately, through the installer:
export ONECLI_VERSION=2.1.0
curl -fsSL https://onecli.sh/install | sh

# Or stay on the pin and just restart, editing ~/.onecli/.env by hand:
docker compose -p onecli -f ~/.onecli/docker-compose.yml up -d
docker pull ghcr.io/onecli/onecli-agent:2.0.0   # the agent image, by hand
```

On every `up`, a one-shot
`migrations` service (its own small image, `onecli-migrations`, pinned by the
same `ONECLI_VERSION` so schema and code always move together) applies any
pending database migrations before the api starts (view its output with
`docker compose logs migrations`; re-run it with
`docker compose up -d` or explicitly `docker compose run --rm migrations`). If
a migration fails, the stack refuses to start rather than serving against a
half-migrated schema — fix the cause, then `up -d` again. Re-running the
installer also refreshes the compose file itself, so the stack topology stays
current alongside the images. Sizing a host for hosted
agents (memory per sandbox, the held-awake ceiling) is covered in
[`apps/runner/README.md`](../apps/runner/README.md).

## Accounts and registration

The first visit asks you to **create an account** — email and password.
Registration stays open by design: every new account gets its own
organization, fenced from everyone else's, so a stranger signing up takes
nothing from existing users. Joining somebody **else's** organization
goes through an invitation; registering without one starts a fresh org.
A deployment that must not accept strangers keeps its dashboard behind the
network boundary — there is deliberately no registration switch. (The one
narrow refusal: sign-ups are blocked during a pre-2.0 upgrade window until the
legacy account is adopted.)

Setting `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` adds a "Continue with
Google" button beside the password form (redirect URI:
`<API_URL>/auth/callback/google`).

**A hosted agent needs a granted model key.** The order matters: store the
key, **grant it to the agent**, then chat. A sandbox will not start without
one — the agent answers in the thread telling you so.

You can change your password any time from **Account → Preferences**, which
also signs out every other session.

## Upgrading from a pre-login release

Your existing organization, workspaces, agents and API keys move to the
account you create — nothing to migrate by hand. **Register immediately
after upgrading**: the old install's data is handed to the first account
that registers, so on a reachable host don't let a stranger get there first
(that release let in anyone who could reach it; creating your account is
what ends that). If your `.env` still sets `NEXTAUTH_SECRET`, rename it to
`BETTER_AUTH_SECRET`; everyone signs in again once.

## Configuration

| Variable                               | Description                                               | Default                       |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| `DATABASE_URL`                         | PostgreSQL connection string                              | Written by `pnpm dev`         |
| `BETTER_AUTH_SECRET`                   | Signs session cookies                                     | Generated by `pnpm dev`/setup |
| `SECRET_ENCRYPTION_KEY`                | AES-256-GCM key for stored secrets                        | Generated by `pnpm dev`/setup |
| `GATEWAY_INTERNAL_SECRET`              | Authenticates the gateway to the API                      | Generated by `pnpm dev`/setup |
| `GATEWAY_UPSTREAM_HEADER_TIMEOUT_SECS` | Bound on the gateway's wait for upstream response headers | `300`                         |
| `GOOGLE_CLIENT_ID`                     | Optional — adds a Google sign-in button                   | —                             |
| `GOOGLE_CLIENT_SECRET`                 | Optional — Google OAuth client secret                     | —                             |

Every required value is generated for you — by `pnpm dev` into `.env` for
development, by `pnpm run setup` into `docker/.env` for a self-host stack,
and by the install script into `~/.onecli/.env`. `.env.example` documents
the optional settings.

## Networking: one URL, two modes

`ONECLI_EXTERNAL_URL` is the one networking variable most installs set: the
URL people open OneCLI at. Every other address derives from it by one rule:

- **`http://…` means ports mode.** The api and gateway are advertised on the
  same host, on their own ports (`10256` / `10255` by default).
- **`https://…` means proxy mode.** One origin; your reverse proxy terminates
  TLS and routes `/v1` + `/auth` to the api (`:10256`) and `/gw/*`
  (prefix-stripped) to the gateway (`:10255`); everything else goes to the
  dashboard (`:10254`).

The cookie `Secure` flag, OAuth redirect URIs, the CLI's api-host, install
snippets, emails, Slack buttons, and the links the gateway hands agents all
follow from it. Unset means `http://localhost:10254` — correct for a laptop
and for tunnel access.

`ONECLI_BIND_HOST` is the separate, listen-only knob: which interface the
published ports bind on. The installers detect and persist it; it never
shapes a URL.

### Scenarios

| Scenario                                              | What to set                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Laptop / trying it out                                | Nothing                                                                                                                                    |
| Isolated VM reached via a tunnel (`ssh -L`, SSM, IAP) | Nothing — localhost is the correct advertised address; forward ports 10254, 10255 and 10256                                                |
| Permanent machine on a LAN                            | `ONECLI_EXTERNAL_URL=http://192.168.1.20:10254` and `ONECLI_BIND_HOST=0.0.0.0` (or run the wizard, which asks both questions)              |
| Public domain behind a TLS proxy                      | `ONECLI_EXTERNAL_URL=https://onecli.example.com` — bind stays local, the proxy connects from the same host                                 |
| Split hosts (app + api domains)                       | `ONECLI_EXTERNAL_URL=https://app.example.com` plus the `API_URL=https://api.example.com` override                                          |
| Reachable at two addresses (IP + DNS name)            | Add the second one to `ONECLI_TRUSTED_ORIGINS` (comma-separated) — it is what lets a browser on that address both sign in and call the API |

Legacy names keep working forever: `APP_URL` is a read-alias of the canonical
URL (it never derives the api/gateway origins — set those explicitly with
it), `API_URL`/`GATEWAY_API_URL` remain per-origin overrides, and
`GATEWAY_BASE_URL` still feeds the agent proxy address under its new name,
`ONECLI_AGENT_PROXY_ADDRESS`.

### Tunnel access (no ingress)

Services bind to localhost (or the docker bridge) by default, so a VM with no
open ports is a first-class deployment: forward the three ports and browse
`http://localhost:10254`.

```sh
ssh -N -L 10254:127.0.0.1:10254 -L 10255:127.0.0.1:10255 -L 10256:127.0.0.1:10256 user@vm
```

On a bare-metal Linux VM the ports bind to the docker bridge address instead
of loopback (so containers on the host can reach the gateway proxy) — the
install's success output and `~/.onecli/.env` record the exact address to
target in `-L`.

### Reverse proxy (proxy mode)

Caddy:

```caddy
onecli.example.com {
    handle /v1/* {
        reverse_proxy 127.0.0.1:10256
    }
    handle /auth/* {
        reverse_proxy 127.0.0.1:10256
    }
    handle_path /gw/* {
        reverse_proxy 127.0.0.1:10255
    }
    handle {
        reverse_proxy 127.0.0.1:10254
    }
}
```

nginx (the `/gw/` trailing slash performs the prefix strip; disable buffering
so token streams and the approvals long-poll flow):

```nginx
location /v1/ { proxy_pass http://127.0.0.1:10256; proxy_buffering off; }
location /auth/ { proxy_pass http://127.0.0.1:10256; }
location /gw/ { proxy_pass http://127.0.0.1:10255/; proxy_buffering off; }
location / { proxy_pass http://127.0.0.1:10254; }
```

The gateway's CONNECT proxy (agent traffic) is raw TCP on `:10255` and cannot
sit behind a path-routing HTTP proxy: agents on other machines need that port
reachable directly (a VPN is the recommended transport), with
`ONECLI_AGENT_PROXY_ADDRESS=onecli.example.com:10255` when the control plane
hands out remote containers.
