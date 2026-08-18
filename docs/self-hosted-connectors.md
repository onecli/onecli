# Self-Hosted Connectors

Some services OneCLI can connect to are self-hosted, so their hostname is
deployment-specific (e.g. `affine.mycompany.com`, `gitea.homelab.local`) rather
than a fixed SaaS domain like `api.github.com`. The gateway matches incoming
requests to providers using a compiled host-pattern table, which means a
self-hosted hostname is not known at build time.

## How It Works

The gateway `HostPattern` enum supports matching a provider's host against the
value of an environment variable, read at match time:

```rust
HostPattern::Env("AFFINE_HOST") // matches when AFFINE_HOST == request hostname
```

- The variable is read once per request — no database access on the hot path.
- Matching is case-insensitive.
- It **never** matches when the variable is unset or empty, so an unconfigured
  self-hosted provider is inert by default.
- The existing `credential_host_field` gate still applies on top: injection only
  proceeds when the request host also equals the host stored on the connection.
  A token therefore cannot leak to a different host even if the environment
  variable is later repointed.

## Configuring a Self-Hosted Host

Set the provider's host environment variable wherever the gateway runs — for
example in `docker-compose.yml`:

```yaml
services:
  gateway:
    environment:
      AFFINE_HOST: affine.mycompany.com
```

No restart-time config files or binary changes are required beyond setting the
variable. Each provider that supports self-hosting documents the specific
variable name it reads.
