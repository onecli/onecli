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

## TLS for self-hosted hosts (internal / non-public CAs)

Self-hosted services in a homelab or private network usually present a TLS
certificate issued by an **internal CA** (e.g. Smallstep, a corporate root, or
mkcert) rather than a publicly-trusted ("top-tier") CA. The gateway's upstream
HTTP client uses the bundled public root store, so it will **not** trust such a
certificate — and forwarding fails with a gateway `502 {"error":
"resolution_failed"}` (the underlying error is a TLS handshake failure, visible
in the gateway logs as `error sending request for url`).

> This is purely an upstream-TLS trust issue: provider host-matching and
> credential injection still work — the gateway just can't complete the TLS
> handshake to the internal host.

You have two options:

### Option 1 — Trust the internal root CA (recommended; keeps full verification)

Point the gateway at your internal CA so it verifies the certificate normally.
`GATEWAY_UPSTREAM_CA_CERT` accepts a PEM file path **or** inline PEM, and the CA
is added **on top of** the public roots (so SaaS hosts keep working):

```yaml
services:
  gateway:
    environment:
      GATEWAY_UPSTREAM_CA_CERT: /etc/onecli/internal-root-ca.crt
    volumes:
      - ./internal-root-ca.crt:/etc/onecli/internal-root-ca.crt:ro
```

### Option 2 — Skip verification for specific hosts (quick; less secure)

If you can't supply the CA, disable verification for the affected hosts only.
`GATEWAY_SKIP_VERIFY_HOSTS` is comma-separated and supports `*.wildcard`:

```yaml
services:
  gateway:
    environment:
      GATEWAY_SKIP_VERIFY_HOSTS: affine.mycompany.com,*.internal.corp
```

This skips TLS verification for those hosts (a potential MITM risk on the
network), so prefer Option 1 where you have access to the root CA.
