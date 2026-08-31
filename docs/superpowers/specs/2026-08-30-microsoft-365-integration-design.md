# Microsoft 365 Integration (Outlook Mail + Calendar)

**Date:** 2026-08-30
**Status:** Approved

## Problem

The catalogue shows "Outlook Mail" and "Outlook Calendar" as locked placeholder
cards (`cloud_only`, `available: false` in `cloud-app-registry.ts`). There is no
Microsoft OAuth or Graph support anywhere in the stack. Users whose primary
email is Outlook cannot connect it.

## Decision: one provider, one card

Microsoft Graph serves mail and calendar from a single host
(`graph.microsoft.com`) under a shared path root (`/v1.0/me/...`). The
gateway's provider disambiguation is host + `starts_with` path prefix
(`apps.rs::provider_for_host_and_path`), which cannot split mail from calendar
the way `gmail.googleapis.com` vs `www.googleapis.com/calendar/` splits Google.

We therefore ship **one provider (`microsoft-365`) and one app card
("Microsoft 365")** covering mail + calendar. Per-capability granularity
(read-only mail, no send, no calendar writes, etc.) lives in the
permissions/policy layer, which already matches per-path/method rules.

Rejected alternatives:

- _Two providers with glob host rules_ — requires extending `HostRule` to glob
  path matching and resolving connection ambiguity for shared endpoints
  (`/v1.0/me`). More gateway surface for no functional gain.
- _One provider, two alias cards_ — the app-id == provider-id assumption runs
  through registry, connections, and policy; aliasing breaks it.

The `outlook-mail` and `outlook-calendar` placeholder entries are **removed**
from `cloud-app-registry.ts`. The `microsoft-word` / `microsoft-onenote`
placeholders stay untouched (out of scope; if implemented later they face the
same shared-host question and should likely fold into this provider).

## Design

### 1. OAuth helper — `packages/api/src/apps/oauth/microsoft.ts` (new)

Cloned from `oauth/google.ts`, exporting:

- `buildMicrosoftAuthUrl` —
  `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` with
  `client_id`, `redirect_uri`, `response_type=code`, `response_mode=query`,
  `scope` (space-joined), `state`. Tenant `common` supports both personal
  Microsoft accounts and work/school accounts.
- `exchangeMicrosoftCode` —
  `POST https://login.microsoftonline.com/common/oauth2/v2.0/token`, form
  body, client credentials in body. Same error handling shape as Google.
  Scopes in the response are space-separated. Compute `expires_at` from
  `expires_in`.
- Metadata: `GET https://graph.microsoft.com/v1.0/me` with the access token →
  `{ username: userPrincipalName ?? mail, name: displayName }`. No avatar
  (Graph's photo endpoint returns binary; skipped).
- `microsoftConfigFields` / `microsoftEnvDefaults` — BYOC fields mirroring
  `googleConfigFields`; env defaults `MICROSOFT_CLIENT_ID` /
  `MICROSOFT_CLIENT_SECRET`.

### 2. App definition — `packages/api/src/apps/microsoft365.ts` (new)

```
id: "microsoft-365"
name: "Microsoft 365"
icon: /icons/microsoft-365.svg   (new icon; existing outlook-*.svg are narrower than the card)
description: "Read and send Outlook email and manage calendar events via Microsoft 365."
available: true
connectionMethod: oauth
```

Default scopes:

```
openid email profile offline_access
User.Read
Mail.ReadWrite
Mail.Send
Calendars.ReadWrite
```

`offline_access` is mandatory — without it the token endpoint issues no
refresh token. `permissions` entries (UI descriptions) for each Graph scope,
same shape as `gmail.ts`. `configurable` with the BYOC fields + env defaults
above. No `teamOnly` flag.

Registered in `registry.ts` `staticApps`. Category mapping in
`app-categories.ts`: `"microsoft-365": "microsoft"` (replacing the two
outlook entries).

### 3. Gateway — `apps/gateway/src/apps.rs`

```rust
static MICROSOFT_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    client_id_env: "MICROSOFT_CLIENT_ID",
    client_secret_env: "MICROSOFT_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

AppProvider {
    provider: "microsoft-365",
    display_name: "Microsoft 365",
    host_rules: &[HostRule {
        pattern: HostPattern::Exact("graph.microsoft.com"),
        path_prefix: None,
        strategy: AuthStrategy::Bearer,
        intercept: false,
    }],
    refresh: Some(&MICROSOFT_REFRESH),
    // all other fields default/empty
}
```

Dedicated host → host-only matching works exactly like
`gmail.googleapis.com`; no `HostRule` changes.

Refresh notes (verify during implementation):

- `refresh_access_token` omits `scope`; Microsoft's v2.0 endpoint accepts
  this and re-issues the originally consented scopes. If real-world refresh
  rejects it, add an optional static-scope field to `RefreshConfig` rather
  than special-casing.
- Microsoft rotates refresh tokens; the response's `refresh_token` is already
  surfaced by `refresh_access_token`'s return value and persisted by the
  caller (same path Notion rotation uses). Confirm persistence end-to-end.

### 4. Permissions catalogue — `packages/api/src/apps/app-permissions/microsoft365.ts` (new)

`AppPermissionDefinition` with `provider: "microsoft-365"`, registered in
`app-permissions/index.ts`. Tools grouped so mail vs calendar stays legible —
this is where the granularity lost by the single-provider decision is
recovered. Host pattern `graph.microsoft.com` throughout; support both
`/v1.0/me/...` and `/v1.0/users/*/...` path forms where the API allows both.

Read group (mail): list messages `/v1.0/me/messages` GET, get message
`/v1.0/me/messages/*` GET, list mail folders `/v1.0/me/mailFolders` GET,
folder messages `/v1.0/me/mailFolders/*/messages` GET.
Read group (calendar): list events `/v1.0/me/events` GET, get event
`/v1.0/me/events/*` GET, calendar view `/v1.0/me/calendarView` GET, list
calendars `/v1.0/me/calendars` GET.
Read group (profile): `/v1.0/me` GET.

Write group (mail): send `/v1.0/me/sendMail` POST, create draft
`/v1.0/me/messages` POST, update `/v1.0/me/messages/*` PATCH, delete
`/v1.0/me/messages/*` DELETE, move `/v1.0/me/messages/*/move` POST, reply
`/v1.0/me/messages/*/reply` and `/replyAll` POST.
Write group (calendar): create `/v1.0/me/events` POST, update
`/v1.0/me/events/*` PATCH, delete `/v1.0/me/events/*` DELETE, respond
`/v1.0/me/events/*/{accept,decline,tentativelyAccept}` POST.

### 5. Env & config plumbing

`MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` added to:

- `packages/api/src/lib/env.ts` (used by connect flow / env defaults)
- `.env.example`
- gateway runtime environment (read via `std::env` by `RefreshConfig` — no
  code change, just deployment env)
- deployment secrets (CDK context / GitHub Actions env for `deploy-app` and
  gateway deploy), same set of places `GOOGLE_CLIENT_*` is provided today

Not touched: `apps/web/src/lib/env.ts` `GOOGLE_CLIENT_*` usages in
`proxy.ts` / `runtime-config.ts` / `nextauth-config.ts` — those are the app's
own login, unrelated to integrations.

### 6. Gateway skill text

`packages/api/src/lib/skills/gateway-skill.ts`: add a Graph example
(`curl -s "https://graph.microsoft.com/v1.0/me/messages?$top=5"`) and mention
Outlook in the "never send the user to their browser" list.

### 7. Manual prerequisite (not automated)

Azure App Registration:

- Supported account types: "Accounts in any organizational directory and
  personal Microsoft accounts" (i.e. `common`)
- Web redirect URI: the existing app-connect OAuth callback URL
- Delegated Graph permissions matching the default scopes; client secret
  generated and stored in deployment secrets

## Error handling

- Authorize errors arrive as `error` / `error_description` callback params —
  surfaced the same way `exchangeGoogleCode` does.
- Token endpoint failures: propagate status + body in the thrown error.
- `/v1.0/me` metadata fetch failure is non-fatal (connection still created,
  metadata undefined) — same as Google.
- Gateway refresh failure falls through to existing behavior (expired token
  forwarded; upstream 401 reaches the agent).

## Testing

- **OAuth helper unit tests**: exchange success (credentials/scopes/metadata
  shape), callback `error` param, missing `code`, token endpoint non-200,
  metadata fetch failure tolerated. Mirror the existing Google helper tests.
- **Gateway tests** (`apps.rs`): `graph.microsoft.com` resolves to
  `microsoft-365` via `provider_for_host` and `provider_for_host_and_path`
  (host-only fallback — no path-scoped rules on this host); refresh config
  wiring present.
- **Registry/permissions tests**: app appears in `getApps()`, permission
  definition resolves for `microsoft-365`, placeholders gone.
- **Manual E2E**: connect a personal Microsoft account; through the gateway run
  `curl https://graph.microsoft.com/v1.0/me/messages?$top=3`; wait past token
  expiry (or force it) and confirm refresh + rotated refresh-token
  persistence; verify a policy block rule on `/v1.0/me/sendMail` POST.

## Out of scope

- Word / OneNote / OneDrive (placeholders remain)
- Splitting mail and calendar into separate providers
- Sovereign/regional Graph clouds (only `graph.microsoft.com`)
- Avatar/photo metadata
