# Vault Integration

Connect an external password manager to OneCLI so the gateway can inject credentials on-demand, without storing them on the server. Two providers are supported, with different models:

- **[Bitwarden](https://bitwarden.com)** (via the [Agent Access SDK](https://github.com/bitwarden/agent-access)) — an on-demand fallback: when no server-stored secret matches a request, the gateway asks your vault for a credential by domain.
- **[1Password](https://1password.com)** (via a Service Account) — a value source for explicit secrets: a secret can reference `op://vault/item/field` instead of storing an encrypted value, and the gateway resolves the reference at request time.

Most of this page covers the Bitwarden flow; see [1Password](#1password) below for its setup.

## How It Works

1. You pair your Bitwarden desktop app with the OneCLI gateway (one-time setup)
2. When an agent makes an HTTPS request and no server-stored secret matches, the gateway asks your Bitwarden vault for a credential
3. Bitwarden searches by domain/URI and returns the match through an encrypted channel
4. The gateway injects the credential as a header (e.g. `x-api-key` for Anthropic, `Authorization: Bearer` for others) and forwards the request
5. The credential is cached in memory for 60 seconds, then discarded

Credentials never hit disk or the database. The vault is a fallback; server-stored secrets always take priority.

## Prerequisites

- OneCLI running locally (`pnpm dev`) or via Docker
- [Bitwarden Agent Access CLI](https://github.com/bitwarden/agent-access/releases) (`aac`) installed
- A Bitwarden account with credentials stored as login items (the password field is used for injection)

## Setup

### 1. Start the `aac` listener

```bash
aac listen --psk
```

This generates a pairing code (two 64-character hex strings joined by `_`). Keep this terminal open.

### 2. Pair in the web dashboard

Open **http://localhost:10254**, pick your workspace, then go to **Connections** > **Vaults** > **Bitwarden**. Paste the pairing code and click **Connect Vault**.

The gateway establishes an encrypted Noise protocol session with your Bitwarden app through a WebSocket relay.

### 3. Test it

```bash
# Use your agent's access token
curl -x http://x:YOUR_AGENT_TOKEN@localhost:10255 https://httpbin.org/headers
```

If your Bitwarden vault has a login item with `httpbin.org` as the URI, the password will be injected as `Authorization: Bearer <password>`.

## Credential Matching

The gateway asks Bitwarden for credentials by domain. Bitwarden matches against the URI field of your vault items. The injection rule depends on the host:

| Host                | Header          | Format           |
| ------------------- | --------------- | ---------------- |
| `api.anthropic.com` | `x-api-key`     | Raw value        |
| Everything else     | `Authorization` | `Bearer <value>` |

To use this with Anthropic, store your API key as the password in a Bitwarden login item with URI `api.anthropic.com`.

## Environment Variables

| Variable              | Default                     | Description                                              |
| --------------------- | --------------------------- | -------------------------------------------------------- |
| `BITWARDEN_PROXY_URL` | `wss://ap.lesspassword.dev` | WebSocket relay for the Bitwarden Remote Access protocol |

## Session Behavior

- Sessions are restored from the database on first credential request after a gateway restart, not at startup.
- Sessions unused for 30 minutes are evicted from memory. The next request restores them from the database automatically.
- If a session can't be restored (e.g. the Bitwarden app was reinstalled), disconnect in the UI and pair again with a new code.

## 1Password

1Password connects with a [Service Account](https://developer.1password.com/docs/service-accounts/) token instead of app pairing, and it is not a hostname-matched fallback: it supplies values for secrets you explicitly point at it. A secret with an `op://vault/item/field` reference is resolved through the 1Password SDK at request time, so the value never sits in the OneCLI database.

Setup: **Connections** > **Vaults** > **1Password**, paste a Service Account token, then create secrets that reference vault items (the UI has a vault/item/field picker backed by `GET /v1/vault/onepassword/{vaults,items,fields}`).

## Architecture

The vault system is provider-agnostic: each provider implements the `VaultProvider` trait, and pairing/status/disconnect are served on provider-generic routes.

```
Browser ──► Gateway /v1/vault/:provider/pair   (pairing / connecting)
Agent   ──► Gateway CONNECT host:443            (credential injection)
              │
              ├─ DB secrets matched? ──► inject from DB (op:// values resolve via 1Password)
              └─ No match + Bitwarden paired? ──► ask Bitwarden ──► inject
```

Key files:

| File                       | Role                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `vault/mod.rs`             | `VaultProvider` trait + `VaultService` orchestrator         |
| `vault/bitwarden.rs`       | Bitwarden provider (sessions, pairing, caching)             |
| `vault/bitwarden_db.rs`    | DB-backed identity + session storage                        |
| `vault/onepassword.rs`     | 1Password provider (Service Account session, `op://` cache) |
| `vault/onepassword_api.rs` | Bridge to the Node 1Password SDK service                    |
| `vault/api.rs`             | REST endpoints for pair/status/disconnect + the 1P picker   |
