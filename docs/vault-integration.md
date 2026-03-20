# Vault Integration

Connect an external password manager to OneCLI so the gateway can inject credentials on-demand, without storing them on the server. Currently supports [Bitwarden](https://bitwarden.com) via the [Agent Access SDK](https://github.com/bitwarden/agent-access).

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

Open **http://localhost:10254** > **Secrets** > **Bitwarden Vault** card. Paste the pairing code and click **Connect Vault**.

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

## Architecture

The vault system is provider-agnostic. Bitwarden is the first implementation. Future providers (1Password, etc.) can be added by implementing the `VaultProvider` trait.

```
Browser ──► Gateway /api/vault/bitwarden/pair   (pairing)
Agent   ──► Gateway CONNECT host:443            (credential injection)
              │
              ├─ DB secrets matched? ──► inject from DB
              └─ No match + vault paired? ──► ask Bitwarden ──► inject
```

Key files:

| File                    | Role                                                |
| ----------------------- | --------------------------------------------------- |
| `vault/mod.rs`          | `VaultProvider` trait + `VaultService` orchestrator |
| `vault/bitwarden.rs`    | Bitwarden provider (sessions, pairing, caching)     |
| `vault/bitwarden_db.rs` | DB-backed identity + session storage                |
| `vault/api.rs`          | REST endpoints for pair/status/disconnect           |
