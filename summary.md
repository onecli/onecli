# Remote Access Integration

The remote access integration lets the gateway inject credentials from a user's vault into HTTPS requests, as a fallback when no server-stored secrets match. Bitwarden is the first provider — the system is generic via the `VaultProvider` trait.

## How it works

**Pairing (one-time setup):**

1. User runs `aac listen --psk` to generate a pairing code, then pastes it into the web UI (`vault-access-card.tsx`)
2. Browser calls gateway directly: `POST /api/vault/bitwarden/pair` (authenticated via `AuthUser` extractor)
3. Gateway establishes a Noise protocol session through a WebSocket relay, persists identity + session state to DB (`VaultConnection.connectionData` JSON)

**Credential injection (per-request):**

1. Agent sends `CONNECT api.openai.com:443` to the gateway
2. Gateway resolves injection rules from DB-stored secrets (via `connect::resolve`)
3. If no rules matched and the user has a paired vault, gateway calls `vault_service.request_credential(user_id, hostname)`
4. `BitwardenVaultProvider` checks local cache (60s positive / 30s negative TTL), or lazily restores the session from DB and sends a real-time request through the encrypted channel to the `aac listen` process
5. `aac listen` looks up the credential in the user's Bitwarden vault and returns it
6. `inject::vault_credential_to_rules()` converts it to injection rules (Anthropic → `x-api-key`, default → `Bearer`)
7. Gateway MITMs the connection and injects the headers

**Key properties:**

- Credentials never leave the gateway process or hit disk — cached briefly in memory only
- Vault lookup is a fallback — DB-stored secrets always take priority
- Per-user sessions with lazy loading — no startup cost, idle sessions evicted after 30 min
- All vault state in Postgres (single source of truth, no filesystem)

## Components

| File                    | Role                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `vault/mod.rs`          | `VaultProvider` trait, `VaultService` orchestrator                |
| `vault/bitwarden.rs`    | `BitwardenVaultProvider` — per-user sessions, pairing, caching    |
| `vault/bitwarden_db.rs` | DB-backed identity keypair + session persistence (replaces files) |
| `vault/api.rs`          | Axum handlers for pair/status/disconnect (called by browser)      |
| `inject.rs`             | Credential → injection rule conversion                            |
| `vault-access-card.tsx` | Pairing UI (calls gateway directly)                               |
