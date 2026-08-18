<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/onecli-logo-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="assets/onecli-logo-light.gif">
  <img alt="OneCLI" src="assets/onecli-logo-light.gif" width="100%">
</picture>

<p align="center">
  <b>The agent harness built for teams.</b><br/>
  A pro assistant for companies. Give every employee a secured, sandboxed personal agent.
</p>

<p align="center">
  <a href="https://onecli.sh">Website</a> &middot;
  <a href="https://onecli.sh/docs">Docs</a> &middot;
  <a href="https://discord.gg/PSztzsQB3g">Discord</a>
</p>

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/onecli-hero-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="assets/onecli-hero-light.gif">
  <img alt="Every teammate gets an agent. Sandboxed, guarded by one gateway, keys never leave." src="assets/onecli-hero-light.gif" width="100%">
</picture>

## Quick Start

### Cloud-hosted: [onecli.sh](https://onecli.sh)

### Self-hosted

```bash
git clone https://github.com/onecli/onecli.git && cd onecli
pnpm install
pnpm run setup
```

Open http://localhost:10254

## What is OneCLI v2?

OneCLI is an open-source platform for running AI agents as a team. You create an agent per person, give each agent the access it needs, and it works in a sandbox, routed through a gateway that injects the credentials and enforces your policy.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/onecli-flow-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="assets/onecli-flow-light.gif">
  <img alt="How credential injection works" src="assets/onecli-flow-light.gif" width="100%">
</picture>

## Why we built OneCLI?

OneCLI started as a credential vault for AI agents, built in Rust. We found that most of the demand came from individuals and teams running autonomous agents like [Hermes](https://github.com/NousResearch/hermes-agent), [OpenClaw](https://openclaw.ai) and [NanoClaw](https://github.com/nanocoai/nanoclaw). People wanted agents that do real work for the person running them, but two parts were missing:

1. managing secrets and permissions.
2. and for teams - multiplayer management.

Every autonomous agent out there is built for one person. And for one person, they're great. The moment you need to replicate that across a team, it gets messy: spinning up each agent, deciding what each one can and cannot do, hosting them, keeping track of whose agent is whose.

So we shifted, and built OneCLI v2.

## Built for teams

- **Your identity provider, integrated**: provision agents on behalf of each employee's identity, straight from the company IdP.
- **An agent per person**: everyone in the workspace gets their own sandboxed agent, reachable from the dashboard or Slack.
- **One policy, enforced everywhere**: manage the team policy in one place, that any agent in the workspaces would be enforced by.
- **Deterministic human-in-the-loop approvals**: in the chat itself, for things you need 100% control over, like sending the email, deleting the Linear ticket, emptying an S3 bucket.
- **Global connections**: shared at the team level, like LLM keys or service accounts, granted per agent without ever being handed to one.

## The agent

An agent is a durable thing, not a single prompt. It has:

- **A computer**: its own isolated sandbox, with a filesystem and a shell. The only way out is the gateway, so it can reach what you granted and nothing else.
- **A conversation**: its own page in the dashboard, or Slack. Images and files included. A message sent while the agent is working redirects it right away instead of queueing behind it.
- **Memory**: what the agent learns is kept by the platform, so it is never lost. You can read and edit it any time.
- **Skills**: instructions and helpers you write once, always available to the agent.
- **A schedule**: the agent can plan future work, and the platform wakes it at the right time.
- **Credentials it never sees**: each agent gets only the access you granted, and the gateway enforces it on every request. Or connect Bitwarden or 1Password for [on-demand injection](docs/vault-integration.md), with nothing stored on the server.
- **Its own Slack app**: connect it once and it answers in channels and DMs under its own name and avatar, with files and images. Delete the agent and its Slack app goes with it.

Agents run on your own infrastructure. The runner is outbound-only and holds no inbound ports, so a laptop, a homelab, or a VPC behind NAT all work with no ingress and no tunnel.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/onecli-architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/onecli-architecture-light.svg">
  <img alt="OneCLI Architecture" src="assets/onecli-architecture-dark.svg" width="100%">
</picture>

- **[Web Dashboard](apps/web)**: Next.js app. Create agents, chat with them, edit their memory and skills, manage connections, secrets and grants.
- **[API Server](apps/api-server)**: the control plane. Owns the database, the conversation plane, and the work queue the runner polls.
- **[Rust Gateway](apps/gateway)**: intercepts outbound requests (HTTPS included, via MITM) and injects credentials. Agents authenticate with access tokens via `Proxy-Authorization` headers.
- **[Runner](apps/runner)**: starts, parks and reaps agent sandboxes. Outbound-only, and never touches the database.
- **[Sandbox Supervisor](apps/sandbox-supervisor)**: runs inside each sandbox, speaking a vendor-neutral harness interface so the agent runtime is swappable.
- **[Channel Adapter](apps/channel-adapter)**: the Slack daemon, one app per agent.
- **Secret Store**: AES-256-GCM at rest, decrypted only at request time, matched by host and path pattern, injected as headers or query parameters.

## Local Development

```bash
git clone https://github.com/onecli/onecli.git && cd onecli
mise install
pnpm install
pnpm dev
```

That's the whole setup: `pnpm dev` generates `.env` with every required secret, starts PostgreSQL, applies migrations, and runs the full stack. Prerequisites, the command reference, project structure, and configuration live in [docs/development.md](docs/development.md).

## Contributing

Contributions are welcome. Read the [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before getting started. Contributions are accepted under the terms of the [Contributor License Agreement](CLA.md).

## Security

To report a vulnerability, please follow our [Security Policy](SECURITY.md). Do not open a public issue for security reports.

## License

[Apache-2.0](LICENSE), with one exception: the `ee/` directories hold
enterprise features under the [OneCLI Enterprise License](LICENSE-ENTERPRISE),
each carrying a notice that points at it. That license is free for development,
testing and evaluation, and requires a subscription for production use.
Everything else is Apache-2.0 and can be self-hosted in production with no
commercial license. [LICENSE-ENTERPRISE](LICENSE-ENTERPRISE) carries the
authoritative list of licensed paths.
