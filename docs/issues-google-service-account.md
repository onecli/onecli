# Google Service Account Support — Issue Plan

> Generated from codebase analysis on 2026-07-06
> Updated: 2026-07-06 — review round 1 (sub claim, hostPattern, async strategy, cache strategy)
> Updated: 2026-07-06 — review round 2 (restore integration tests, cache key versioning, scope/hostPattern UX hint)

## Architecture Overview

The system currently supports 3 secret types (`anthropic`, `openai`, `generic`). Adding `google_service_account` follows the existing Secret flow:

1. **Web UI** → secret-dialog.tsx accepts SA JSON key
2. **Service layer** → validates JSON, encrypts with AES-256-GCM, stores in `Secret.encryptedValue`
3. **Gateway (Rust)** → `connect.rs` resolves SA token (JWT sign + exchange), `secret_inject.rs` injects Bearer token

**Key reuse:** The Vertex AI provider already implements the exact JWT→access_token exchange in `apps/gateway/src/apps.rs:1541-1615` (`refresh_via_service_account()`). The new secret type reuses this signing logic but from the Secret path (not AppConnection).

### Key Files

| Component                   | File                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| Zod validation              | `packages/api/src/validations/secret.ts`                                   |
| Service layer               | `packages/api/src/services/secret-service.ts`                              |
| Encryption                  | `packages/api/src/lib/crypto.ts`                                           |
| Gateway secret resolution   | `apps/gateway/src/connect.rs` (L242-346, L948-1057)                        |
| Gateway injection builder   | `apps/gateway/src/secret_inject.rs`                                        |
| Gateway JWT signing (reuse) | `apps/gateway/src/apps.rs` (L1541-1615)                                    |
| Web UI dialog               | `apps/web/src/app/(dashboard)/connections/_components/secret-dialog.tsx`   |
| Web UI card                 | `apps/web/src/app/(dashboard)/connections/_components/secret-card.tsx`     |
| Web UI content              | `apps/web/src/app/(dashboard)/connections/_components/secrets-content.tsx` |
| Validation tests            | `packages/api/src/validations/secret.test.ts`                              |

---

## Issue #1: feat(api): add `google_service_account` secret type — validation & service layer

### Summary

Add `google_service_account` as a new secret type alongside `anthropic`, `openai`, and `generic`. This is the data-layer foundation for Google Service Account credential support.

### Context

- `Secret.type` is already a free-form `String` in Prisma — no migration needed
- SA JSON keys contain `private_key`, `client_email`, `project_id`, `type: "service_account"`
- These are stored encrypted (AES-256-GCM) in `Secret.encryptedValue`

### Requirements

#### Zod Validation (`packages/api/src/validations/secret.ts`)

- Add `"google_service_account"` to `z.enum` for `type` (~line 204)
- Add value validation: parse JSON, require `type === "service_account"`, `private_key`, `client_email`
- Default `hostPattern` to `www.googleapis.com` (NOT `*.googleapis.com` — see note below)
- `injectionConfig` should be `null` (gateway handles injection internally)

#### Service Layer (`packages/api/src/services/secret-service.ts`)

- Add label: `google_service_account: "Google Service Account"` (~line 34)
- Add metadata extraction: `{ projectId, clientEmail }` (non-sensitive fields only)
- Value normalization: validate JSON structure on create/update, similar to OpenAI OAuth JSON handling

#### No Prisma Migration

- `Secret.type` is `String` — no enum change needed
- **Important:** Verify existing queries don't hard-code only the 3 current types. Known hard-coded locations:
  - `apps/web/src/lib/actions/secrets.ts:97,106` — queries filtering by `type: "anthropic"` / `type: "openai"`
  - `apps/web/src/app/(dashboard)/connections/_components/secret-dialog.tsx:59` — `type SecretType = "anthropic" | "openai" | "generic"`
  - `apps/web/src/app/(dashboard)/connections/_components/secrets-content.tsx:61` — filter logic uses `s.type === "generic"` vs not (SA will correctly fall into "not generic")
  - `apps/web/src/app/(dashboard)/connections/_components/secrets-content.tsx:201` — `["anthropic", "openai"]` limits type dropdown in LLM view

#### hostPattern: why `www.googleapis.com` not `*.googleapis.com`

- `*.googleapis.com` would match `oauth2.googleapis.com`, which is the token exchange endpoint. This risks circular injection (inject → exchange → inject).
- It also collides with existing Vertex AI app connections (`*-aiplatform.googleapis.com`).
- Users can override to a broader pattern if needed, but the safe default is `www.googleapis.com`.

### Done When

- `google_service_account` accepted as valid secret type in create/update APIs
- SA JSON key validated (required fields: `type`, `private_key`, `client_email`)
- Default hostPattern is `www.googleapis.com`
- Existing tests pass
- New validation tests added for the new type

---

## Issue #2: feat(web): SA JSON key upload UI in secret dialog

### Summary

Add `google_service_account` option to the secret creation dialog with JSON key file upload/paste support.

### Context

- Secret dialog at `apps/web/src/app/(dashboard)/connections/_components/secret-dialog.tsx`
- Secret card at `apps/web/src/app/(dashboard)/connections/_components/secret-card.tsx`
- Follows existing patterns: type selector dropdown, value input, host pattern auto-fill

### Requirements

#### Secret Dialog (`secret-dialog.tsx`)

- Update `SecretType` union type (line 59) to include `"google_service_account"`
- Add "Google Service Account" to type selector options array (~line 95)
- When selected:
  - Show textarea/file-upload for SA JSON key (similar to OpenAI OAuth JSON input)
  - Auto-fill `hostPattern` to `www.googleapis.com`
  - Hide injection config section (not user-configurable for this type)
  - Validate JSON on paste/upload: check `type === "service_account"`, `private_key`, `client_email` present
  - Show extracted `client_email` and `project_id` as read-only metadata preview
  - Display scope hint: e.g. "MVP: Drive read-only access (drive.readonly). Broader scopes coming soon." — this prevents user confusion when they widen hostPattern but hit 403s due to insufficient scope.
- File upload: accept `.json` files, read and populate textarea

#### Secret Card (`secret-card.tsx`)

- Display "Google Service Account" badge for `google_service_account` type
- Show `client_email` from metadata (if available)

#### Secrets Content (`secrets-content.tsx`)

- `google_service_account` is NOT an LLM type — the existing filter `s.type === "generic" ? ... : s.type !== "generic"` correctly places it in the non-generic (i.e. "connections") tab. Verify this works correctly.
- Consider whether SA secrets should appear in the "Custom" tab (generic filter) or a new category. For MVP, they should appear alongside apps/connections.

#### Host Pattern

- Default to `www.googleapis.com` when type is selected
- Allow user override (some users may want broader patterns for specific APIs)

### Done When

- User can create a `google_service_account` secret via UI
- JSON key is validated before submission
- Metadata (clientEmail, projectId) displayed on card
- Default hostPattern is `www.googleapis.com`
- Existing secret types unaffected

---

## Issue #3: feat(gateway): JWT signing & Bearer token injection for `google_service_account` secrets

### Summary

Add gateway-side JWT signing, token exchange, in-memory caching, and Bearer injection for `google_service_account` secrets targeting `www.googleapis.com` requests.

### Context

The Vertex AI provider already implements the JWT→access_token pattern in `apps/gateway/src/apps.rs:1541-1615`:

- `refresh_via_service_account()` — signs JWT with RS256, exchanges at `oauth2.googleapis.com/token`
- Uses `jsonwebtoken` crate for signing

The new secret type needs a similar flow but triggered from the **Secret** path (not AppConnection).

### Requirements

#### Architecture: Follow existing async token resolution pattern (Option 2)

The existing code resolves tokens in the **connect phase** (`resolve_secret_injections()` at `connect.rs:242-346`), then passes the resolved value to the sync `build_injections()`. Evidence:

- OpenAI OAuth: `refresh_openai_oauth_if_expired()` is called at `connect.rs:307-318` **before** `build_injections()` at line 323
- AppConnection tokens: `resolve_access_token()` at `connect.rs:948-1057` handles token refresh in the connect phase

**Do NOT make `build_injections()` async.** Instead, add a new `resolve_google_sa_token()` async function called from `resolve_secret_injections()`, following the exact same pattern as OpenAI OAuth refresh.

#### Token Resolution (`apps/gateway/src/connect.rs`)

- In `resolve_secret_injections()`, after value resolution (~line 296):
  - If `secret.type_ == "google_service_account"`: call `resolve_google_sa_token()`
  - Parse decrypted JSON to extract `private_key` and `client_email`
  - Check in-memory cache for a valid (non-expired) access token
  - If cache miss or expired: call `refresh_via_service_account()` (reuse from `apps.rs`)
  - Store result in in-memory cache
  - Return the access token as the effective value

#### JWT Claims (NO `sub` claim)

- `iss`: client_email
- `aud`: `https://oauth2.googleapis.com/token`
- `scope`: `https://www.googleapis.com/auth/drive.readonly`
- `iat`: now
- `exp`: now + 3600

**Do NOT include `sub`.** The `sub` claim is for domain-wide delegation (impersonating a user). Without DWD, `sub` is unnecessary and can cause `invalid_grant` errors. The existing Vertex AI code (`apps.rs:1565`) does include `sub: client_email`, but that's for GCP cloud-platform scope where it's tolerated. For the new generic SA secret type, omit it. Note: this means we need a new JWT claims struct (or make `sub` optional in the existing one) rather than reusing `ServiceAccountClaims` directly.

#### Secret Injection (`apps/gateway/src/secret_inject.rs`)

- Add `"google_service_account"` match arm in `build_injections()`
- The effective value passed in will already be the resolved access token (not the SA JSON)
- Return `SetHeader("authorization", "Bearer {access_token}")`

#### Token Caching: In-Memory TTL (NOT DB write-back)

- Use in-memory cache with ~50 minute TTL (3000 seconds)
- **Cache key:** `sa_token:{secret_id}:{hash_of_encrypted_value}` (or use `updatedAt` timestamp). Including a value-version component ensures that when a user rotates the SA key via the dashboard, the cache is immediately invalidated rather than serving a stale token for up to 50 minutes. The existing injection rules cache (`connect.rs:636-650`) uses a fixed key per connection and relies on short TTL (60s) — our longer TTL requires explicit version-awareness.
- **Do NOT write back to `encryptedValue`** — mixing immutable SA keys with volatile cache tokens creates write contention and complicates key rotation
- Gateway restart = token re-exchange (negligible cost: one HTTP round-trip per SA)

#### Safety: Guard against `oauth2.googleapis.com` injection

- In `resolve_secret_injections()` or `build_injections()`, explicitly skip injection when hostname is `oauth2.googleapis.com`
- This prevents circular injection if a user sets a broader hostPattern

### Done When

- Agent request to `www.googleapis.com` with an assigned `google_service_account` secret gets Bearer token injected
- Token is refreshed automatically when expired (~50 min cache)
- JWT does not contain `sub` claim
- In-memory cache, no DB write-back for access tokens
- `oauth2.googleapis.com` requests are explicitly excluded from injection
- `build_injections()` remains synchronous
- Gateway compiles and existing tests pass

---

## Issue #4: test: unit & integration tests for `google_service_account` flow

### Summary

Add tests covering the full SA secret flow: validation, service layer, and gateway injection.

### Context

- Validation tests: `packages/api/src/validations/secret.test.ts` (Vitest, `describe`/`it.each` patterns)
- Service tests: `packages/api/src/services/api-key-service.test.ts` (mock DB pattern)
- Gateway inline tests: `apps/gateway/src/secret_inject.rs` (`#[cfg(test)]` module)
- Gateway integration tests: `apps/gateway/tests/integration.rs`

### Requirements

#### Validation Tests (`packages/api/src/validations/secret.test.ts`)

- Valid SA JSON key accepted
- Missing `private_key` rejected
- Missing `client_email` rejected
- Wrong `type` field rejected (e.g., `type: "authorized_user"`)
- Non-JSON value rejected
- Default hostPattern set to `www.googleapis.com`

#### Service Layer Tests

- Create google_service_account secret — metadata extracted correctly
- Update — re-validates JSON
- Metadata contains `projectId` and `clientEmail` (not `private_key`)

#### Gateway Inline Tests (`apps/gateway/src/secret_inject.rs` — `#[cfg(test)]`)

- `build_injections("google_service_account", ...)` returns correct `SetHeader("authorization", "Bearer {token}")`
- Unknown/malformed effective value returns empty injections

#### Gateway Token Resolution Tests (`resolve_google_sa_token`)

**This is the most critical test surface — the core logic lives here.**

- Cache hit: returns cached token without calling `refresh_via_service_account()` (no HTTP exchange)
- Cache miss: calls `refresh_via_service_account()`, stores result in cache, returns token
- Expired cache entry: triggers re-exchange via `refresh_via_service_account()`
- Token exchange failure: returns error, does not cache a failed result
- Cache key versioning: after SA key rotation (changed `encryptedValue`), old cache entry is not used
- Determine test approach at implementation time: check if `apps/gateway/tests/integration.rs` has existing patterns for mocking HTTP (e.g., mock server for `oauth2.googleapis.com/token`) or if unit tests with dependency injection are more appropriate

#### Security Tests (important)

- SA JSON `private_key` never appears in log output, error messages, or traces
- Metadata extraction excludes `private_key` from stored metadata
- Token exchange errors don't leak the private key in error strings

### Done When

- All new tests pass
- Existing tests unaffected
- Coverage for happy path + key error cases
- `resolve_google_sa_token` cache behavior tested (hit, miss, expiry, rotation)
- Security: private key never leaks into logs/metadata

---

## Review Corrections Applied

| #   | Original                                                 | Corrected                                   | Rationale                                                                                                           |
| --- | -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | JWT includes `sub: client_email`                         | **Remove `sub` claim**                      | `sub` is for domain-wide delegation impersonation; unnecessary without DWD and can cause `invalid_grant`            |
| 2   | Default hostPattern `*.googleapis.com`                   | **Default `www.googleapis.com`**            | Prevents circular injection on `oauth2.googleapis.com` and collision with Vertex AI `*-aiplatform.googleapis.com`   |
| 3   | Async option 1 preferred (make `build_injections` async) | **Option 2: pre-resolve in connect phase**  | Matches existing OpenAI OAuth pattern (`connect.rs:307-318`); keeps `build_injections()` sync; smaller blast radius |
| 4   | Cache via DB write-back to `encryptedValue`              | **In-memory TTL cache**                     | Separates immutable credentials from volatile tokens; avoids write contention; simpler key rotation                 |
| 5   | —                                                        | **Guard `oauth2.googleapis.com`**           | Explicit skip to prevent injection on token exchange endpoint                                                       |
| 6   | —                                                        | **Security test: private key not in logs**  | Added to Issue #4 test requirements                                                                                 |
| 7   | Issue #4 only had `secret_inject.rs` inline tests        | **Restore `resolve_google_sa_token` tests** | Token resolution is the core logic; cache hit/miss/expiry/rotation must be tested                                   |
| 8   | Cache key: secret ID only                                | **Cache key: `secret_id + value_version`**  | 50-min TTL + key rotation = stale tokens; adding encrypted value hash gives instant invalidation at near-zero cost  |
| 9   | —                                                        | **Scope hint in secret dialog UI**          | Prevents user confusion when broadening hostPattern but hitting 403 due to `drive.readonly` scope limitation        |

---

## Issues Created (Local)

| #   | Title                                                                                    | Priority  |
| --- | ---------------------------------------------------------------------------------------- | --------- |
| 1   | feat(api): add `google_service_account` secret type — validation & service layer         | IMMEDIATE |
| 2   | feat(web): SA JSON key upload UI in secret dialog                                        | IMMEDIATE |
| 3   | feat(gateway): JWT signing & Bearer token injection for `google_service_account` secrets | IMMEDIATE |
| 4   | test: unit & integration tests for `google_service_account` flow                         | QUICK WIN |

**Total: 4 issues**

### Execution Strategy

**IMMEDIATE VALUE (Start Here)**

- Issue #1 — Data layer foundation (no dependencies)
- Issue #2 — Web UI (depends on #1 for type validation, but can be developed in parallel)

**PARALLEL WORK**

- Issue #3 — Gateway injection (depends on #1 for type definition, can start skeleton in parallel)

**AFTER CORE IS WORKING**

- Issue #4 — Tests (can start early for validation tests, gateway tests after #3)

### Future Iterations (Not in scope, but noted)

- **Configurable scopes** (currently hardcoded to `drive.readonly`) — will be needed soon for shared Drive write access (Phase 0 contributor permissions)
- Token interception for Google SDK stub credentials (like Vertex AI pattern)
- Multiple SA secrets per agent with scope-based routing
- SA key rotation support
