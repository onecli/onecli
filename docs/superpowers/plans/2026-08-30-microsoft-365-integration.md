# Microsoft 365 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working "Microsoft 365" integration (Outlook mail + calendar via Microsoft Graph) — OAuth connect flow, gateway credential injection with token refresh, and a permissions catalogue — replacing the locked Outlook placeholder cards.

**Architecture:** One provider (`microsoft-365`), one app card. TypeScript side (`packages/api`) gets a Microsoft OAuth helper cloned from the Google one, an app definition, and a permissions catalogue. Rust gateway gets one `AppProvider` for `graph.microsoft.com` (dedicated host → host-only matching, like `gmail.googleapis.com`) plus a `RefreshConfig`. Mail-vs-calendar granularity lives in the permissions layer, not in provider split.

**Tech Stack:** TypeScript (packages/api), vitest (NEW — first JS test harness in the repo), Rust (apps/gateway), Microsoft identity platform v2.0 endpoints, Microsoft Graph v1.0.

**Spec:** `docs/superpowers/specs/2026-08-30-microsoft-365-integration-design.md`

## Global Constraints

- **No host toolchains.** All cargo and pnpm commands run in containers as the host user with caches outside the repo. Define these helpers once per shell session (run from the repo root):

```bash
crun() { docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work/apps/gateway \
  -v "$HOME/.cache/onecli-ci/cargo:/cargo" -e CARGO_HOME=/cargo \
  -v "$HOME/.cache/onecli-ci/home:/hosthome" -e HOME=/hosthome \
  rust:1-bookworm "$@"; }

nrun() { docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  -v "$HOME/.cache/onecli-ci/pnpm-store:/pnpm-store" \
  -v "$HOME/.cache/onecli-ci/corepack:/corepack" -e COREPACK_HOME=/corepack \
  -v "$HOME/.cache/onecli-ci/home:/hosthome" -e HOME=/hosthome \
  node:22-bookworm bash -c "export PATH=/hosthome/.bin:\$PATH; corepack enable --install-directory /hosthome/.bin >/dev/null 2>&1; pnpm config set store-dir /pnpm-store >/dev/null; $*"; }
```

(`corepack enable` without `--install-directory` tries to write root-owned `/usr/local/bin` and fails silently under the host-UID mapping; the variant above installs shims into the writable cache home.)

`podman` works too if docker is unavailable. Never run `pnpm install` or `cargo` directly on the host.

- **Do NOT run root `pnpm test`** (turbo would invoke `cargo test` on the host, which has no cargo). Use filtered commands: `nrun pnpm --filter @onecli/api test` and `crun cargo test`.
- **Formatting hooks:** lint-staged/prettier runs on commit; `cargo fmt` must be run via `crun cargo fmt` before committing Rust changes (no `.go` files here, the gofmt hook no-ops).
- **Branch:** work on `feat/microsoft-365-integration` (already exists, spec committed).
- **Code style:** const arrow functions, named exports, strong typing, no `any` (see repo CLAUDE.md).
- **Naming (verbatim from spec):** provider/app id `microsoft-365`, display name `Microsoft 365`, env vars `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`, tenant `common`.
- **Spec deviation, already validated:** spec §5 says to add the env vars to `packages/api/src/lib/env.ts`; this is NOT needed — `resolve-credentials.ts` reads `process.env[envVar]` directly from the app's `envDefaults` map. Only `.env.example` and deployment secrets carry the new vars.

---

### Task 1: Vitest harness + Microsoft OAuth helper

**Files:**

- Modify: `packages/api/package.json` (add vitest + test script)
- Create: `packages/api/src/apps/oauth/microsoft.ts`
- Test: `packages/api/src/apps/oauth/microsoft.test.ts`

**Interfaces:**

- Consumes: `OAuthBuildAuthUrlParams`, `OAuthExchangeCodeParams`, `OAuthExchangeResult`, `OAuthConfigField` from `packages/api/src/apps/types.ts` (existing).
- Produces (Task 2 imports these from `./oauth/microsoft`):
  - `buildMicrosoftAuthUrl(params: OAuthBuildAuthUrlParams): string`
  - `exchangeMicrosoftCode(params: OAuthExchangeCodeParams): Promise<OAuthExchangeResult>`
  - `microsoftConfigFields: OAuthConfigField[]`
  - `microsoftEnvDefaults: { clientId: "MICROSOFT_CLIENT_ID"; clientSecret: "MICROSOFT_CLIENT_SECRET" }`

- [ ] **Step 1: Add vitest to packages/api**

In `packages/api/package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

and add a `"devDependencies"` entry (create the block if absent):

```json
"devDependencies": {
  "vitest": "^3.2.4"
}
```

- [ ] **Step 2: Install (containerized)**

Run from repo root: `nrun pnpm install`
Expected: lockfile updated, exits 0. If the store is cold this takes a while; that's fine.

- [ ] **Step 3: Write the failing test**

Create `packages/api/src/apps/oauth/microsoft.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftAuthUrl, exchangeMicrosoftCode } from "./microsoft";

const authParams = {
  appCredentials: { clientId: "client-123", clientSecret: "secret-456" },
  redirectUri: "https://app.example.com/callback",
  scopes: ["openid", "offline_access", "Mail.ReadWrite"],
  state: "state-abc",
};

describe("buildMicrosoftAuthUrl", () => {
  it("builds a v2.0 authorize URL on the common tenant", () => {
    const url = new URL(buildMicrosoftAuthUrl(authParams));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toBe(
      "openid offline_access Mail.ReadWrite",
    );
    expect(url.searchParams.get("state")).toBe("state-abc");
  });
});

const exchangeParams = {
  appCredentials: { clientId: "client-123", clientSecret: "secret-456" },
  callbackParams: { code: "auth-code-789" },
  redirectUri: "https://app.example.com/callback",
};

const tokenResponse = {
  access_token: "at-111",
  refresh_token: "rt-222",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid offline_access Mail.ReadWrite",
};

const meResponse = {
  userPrincipalName: "dewey@example.com",
  mail: "dewey@example.com",
  displayName: "Dewey Sasser",
};

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

describe("exchangeMicrosoftCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code and fetches /me metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(tokenResponse))
      .mockResolvedValueOnce(jsonRes(meResponse));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeMicrosoftCode(exchangeParams);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(tokenUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    const body = new URLSearchParams(tokenInit.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-789");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("secret-456");

    expect(result.credentials.access_token).toBe("at-111");
    expect(result.credentials.refresh_token).toBe("rt-222");
    expect(typeof result.credentials.expires_at).toBe("number");
    expect(result.scopes).toEqual([
      "openid",
      "offline_access",
      "Mail.ReadWrite",
    ]);
    expect(result.metadata).toEqual({
      username: "dewey@example.com",
      name: "Dewey Sasser",
    });
  });

  it("throws on an error callback param", async () => {
    await expect(
      exchangeMicrosoftCode({
        ...exchangeParams,
        callbackParams: {
          error: "access_denied",
          error_description: "user cancelled",
        },
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("throws when the callback has no code", async () => {
    await expect(
      exchangeMicrosoftCode({ ...exchangeParams, callbackParams: {} }),
    ).rejects.toThrow(/missing authorization code/);
  });

  it("throws when the token endpoint returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonRes({ error: "bad" }, false, 400)),
    );
    await expect(exchangeMicrosoftCode(exchangeParams)).rejects.toThrow(
      /token exchange failed/,
    );
  });

  it("tolerates a failed /me metadata fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonRes(tokenResponse))
        .mockResolvedValueOnce(jsonRes({}, false, 500)),
    );
    const result = await exchangeMicrosoftCode(exchangeParams);
    expect(result.credentials.access_token).toBe("at-111");
    expect(result.metadata).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `nrun pnpm --filter @onecli/api test`
Expected: FAIL — cannot resolve `./microsoft`.

- [ ] **Step 5: Implement the helper**

Create `packages/api/src/apps/oauth/microsoft.ts` (mirrors `oauth/google.ts` structure):

```typescript
import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "../types";

const AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * Build a Microsoft identity platform v2.0 authorization URL.
 * Uses the `common` tenant so both personal Microsoft accounts and
 * work/school accounts can sign in.
 */
export const buildMicrosoftAuthUrl = ({
  appCredentials,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appCredentials.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
};

/**
 * Exchange an authorization code for Microsoft OAuth tokens.
 */
export const exchangeMicrosoftCode = async ({
  appCredentials,
  callbackParams,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  if (callbackParams.error) {
    throw new Error(
      `Microsoft authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
    );
  }

  if (!callbackParams.code) {
    throw new Error("Microsoft callback missing authorization code");
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: callbackParams.code!,
      client_id: appCredentials.clientId!,
      client_secret: appCredentials.clientSecret!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    throw new Error(
      `Microsoft token exchange failed: ${tokenRes.status} ${tokenRes.statusText} — ${errorBody}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ?? "Failed to exchange code for token",
    );
  }

  const expiresAt = tokenData.expires_in
    ? Math.floor(Date.now() / 1000) + tokenData.expires_in
    : undefined;

  const credentials: Record<string, unknown> = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    expires_at: expiresAt,
  };

  // Microsoft returns scopes space-separated
  const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

  // Fetch user profile for connection metadata (non-fatal on failure)
  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    const user = (await userRes.json()) as {
      userPrincipalName?: string;
      mail?: string;
      displayName?: string;
    };
    metadata = {
      username: user.userPrincipalName ?? user.mail,
      name: user.displayName,
    };
  }

  return { credentials, scopes, metadata };
};

/** Standard BYOC config fields for Microsoft OAuth apps. */
export const microsoftConfigFields: OAuthConfigField[] = [
  {
    name: "clientId",
    label: "Application (client) ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "Secret value from Azure App Registration",
    secret: true,
  },
];

/** envDefaults for apps that use the shared platform Microsoft credentials. */
export const microsoftEnvDefaults = {
  clientId: "MICROSOFT_CLIENT_ID",
  clientSecret: "MICROSOFT_CLIENT_SECRET",
} as const;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `nrun pnpm --filter @onecli/api test`
Expected: PASS (6 tests).

- [ ] **Step 7: Lint + types**

Run: `nrun pnpm --filter @onecli/api lint && nrun pnpm --filter @onecli/api check-types`
Expected: clean. Fix anything reported before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/api/package.json pnpm-lock.yaml packages/api/src/apps/oauth/microsoft.ts packages/api/src/apps/oauth/microsoft.test.ts
git commit -m "feat(api): add Microsoft OAuth helper with vitest harness"
```

---

### Task 2: App definition, registry, placeholder removal

**Files:**

- Create: `packages/api/src/apps/microsoft365.ts`
- Modify: `packages/api/src/apps/registry.ts` (import + `staticApps` entry)
- Modify: `packages/api/src/apps/cloud-app-registry.ts` (delete `outlook-mail` and `outlook-calendar` entries, lines ~13–28)
- Modify: `apps/web/src/app/(dashboard)/connections/_components/app-categories.ts` (swap outlook entries for `microsoft-365`)
- Modify: `.env.example` (add `MICROSOFT_CLIENT_ID=` / `MICROSOFT_CLIENT_SECRET=` next to the Google pair)
- Test: `packages/api/src/apps/registry.test.ts`

**Interfaces:**

- Consumes: `buildMicrosoftAuthUrl`, `exchangeMicrosoftCode`, `microsoftConfigFields`, `microsoftEnvDefaults` from Task 1; `AppDefinition` from `./types`.
- Produces: `microsoft365: AppDefinition` export (Tasks 3–4 rely on id `microsoft-365`); `getApp("microsoft-365")` resolves.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/apps/registry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getApp, getApps } from "./registry";

describe("registry: microsoft-365", () => {
  it("exposes an available microsoft-365 OAuth app", () => {
    const app = getApp("microsoft-365");
    expect(app).toBeDefined();
    expect(app!.available).toBe(true);
    expect(app!.name).toBe("Microsoft 365");
    expect(app!.connectionMethod.type).toBe("oauth");
    if (app!.connectionMethod.type === "oauth") {
      expect(app!.connectionMethod.defaultScopes).toContain("offline_access");
      expect(app!.connectionMethod.defaultScopes).toContain("Mail.ReadWrite");
      expect(app!.connectionMethod.defaultScopes).toContain(
        "Calendars.ReadWrite",
      );
    }
    expect(app!.configurable?.envDefaults).toEqual({
      clientId: "MICROSOFT_CLIENT_ID",
      clientSecret: "MICROSOFT_CLIENT_SECRET",
    });
    expect(app!.teamOnly).toBeUndefined();
  });

  it("no longer lists the outlook placeholder cards", () => {
    const ids = getApps().map((a) => a.id);
    expect(ids).not.toContain("outlook-mail");
    expect(ids).not.toContain("outlook-calendar");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nrun pnpm --filter @onecli/api test`
Expected: registry tests FAIL (`getApp("microsoft-365")` undefined, outlook ids still present). Task 1 tests still pass.

- [ ] **Step 3: Create the app definition**

Create `packages/api/src/apps/microsoft365.ts`:

```typescript
import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const microsoft365: AppDefinition = {
  id: "microsoft-365",
  name: "Microsoft 365",
  icon: "/icons/microsoft-365.svg",
  description:
    "Read and send Outlook email and manage calendar events via Microsoft 365.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
    ],
    permissions: [
      {
        scope: "Mail.ReadWrite",
        name: "Read and manage emails",
        description: "Read, draft, and organize your Outlook email",
        access: "write",
      },
      {
        scope: "Mail.Send",
        name: "Send emails",
        description: "Send email on your behalf",
        access: "write",
      },
      {
        scope: "Calendars.ReadWrite",
        name: "Manage calendar",
        description: "View, create, and update calendar events",
        access: "write",
      },
      {
        scope: "User.Read",
        name: "Profile",
        description: "Name and email address",
        access: "read",
      },
    ],
    buildAuthUrl: buildMicrosoftAuthUrl,
    exchangeCode: exchangeMicrosoftCode,
  },
  available: true,
  configurable: {
    fields: microsoftConfigFields,
    envDefaults: microsoftEnvDefaults,
    hint: "Use credentials from an Azure App Registration (common tenant)",
  },
};
```

- [ ] **Step 4: Register it and remove the placeholders**

In `packages/api/src/apps/registry.ts`: add `import { microsoft365 } from "./microsoft365";` with the other imports and add `microsoft365,` to the `staticApps` array (after `gmail,` keeps the diff tidy).

In `packages/api/src/apps/cloud-app-registry.ts`: delete the two whole objects with ids `outlook-mail` and `outlook-calendar` (currently lines ~13–28). Do not touch `microsoft-word` / `microsoft-onenote`.

In `apps/web/src/app/(dashboard)/connections/_components/app-categories.ts`, replace:

```typescript
  // Microsoft
  "outlook-mail": "microsoft",
  "outlook-calendar": "microsoft",
```

with:

```typescript
  // Microsoft
  "microsoft-365": "microsoft",
```

(keep the `microsoft-word` / `microsoft-onenote` lines).

In `.env.example`, directly below the `GOOGLE_CLIENT_SECRET=` line, add:

```
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `nrun pnpm --filter @onecli/api test`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 6: Lint + types (api and web)**

Run: `nrun pnpm --filter @onecli/api --filter web lint && nrun pnpm --filter @onecli/api --filter web check-types`
Expected: clean. (If the web app's package name isn't `web`, check `apps/web/package.json` `"name"` and use that filter.)

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/apps/microsoft365.ts packages/api/src/apps/registry.ts packages/api/src/apps/cloud-app-registry.ts packages/api/src/apps/registry.test.ts "apps/web/src/app/(dashboard)/connections/_components/app-categories.ts" .env.example
git commit -m "feat(api): add Microsoft 365 app, retire Outlook placeholders"
```

---

### Task 3: Permissions catalogue

**Files:**

- Create: `packages/api/src/apps/app-permissions/microsoft365.ts`
- Modify: `packages/api/src/apps/app-permissions/index.ts` (import + `register(...)`)
- Test: `packages/api/src/apps/app-permissions/microsoft365.test.ts`

**Interfaces:**

- Consumes: `AppPermissionDefinition` from `./types` (existing: `{ provider: string; groups: { category: "read" | "write"; tools: AppTool[] }[] }`).
- Produces: `microsoft365Permissions: AppPermissionDefinition`; `getAppPermissionDefinition("microsoft-365")` resolves.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/apps/app-permissions/microsoft365.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getAppPermissionDefinition } from "./index";

describe("microsoft-365 permissions", () => {
  const def = getAppPermissionDefinition("microsoft-365");

  it("is registered", () => {
    expect(def).toBeDefined();
    expect(def!.provider).toBe("microsoft-365");
  });

  it("targets graph.microsoft.com exclusively with unique tool ids", () => {
    const tools = def!.groups.flatMap((g) => g.tools);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.hostPattern).toBe("graph.microsoft.com");
    }
    const ids = tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies send_mail as write and list_messages as read", () => {
    const read = def!.groups.find((g) => g.category === "read")!;
    const write = def!.groups.find((g) => g.category === "write")!;
    expect(read.tools.some((t) => t.id === "list_messages")).toBe(true);
    expect(write.tools.some((t) => t.id === "send_mail")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nrun pnpm --filter @onecli/api test`
Expected: FAIL — `getAppPermissionDefinition("microsoft-365")` is undefined.

- [ ] **Step 3: Create the permission definition**

Create `packages/api/src/apps/app-permissions/microsoft365.ts`. `aliasPatterns` carries the `/v1.0/users/*/...` form where Graph supports addressing the same resource by user id:

```typescript
import type { AppPermissionDefinition } from "./types";

export const microsoft365Permissions: AppPermissionDefinition = {
  provider: "microsoft-365",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_profile",
          name: "Read profile",
          description: "Read the signed-in user's profile",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me",
          method: "GET",
        },
        {
          id: "list_messages",
          name: "List email messages",
          description: "List messages in the mailbox",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages",
          aliasPatterns: ["/v1.0/users/*/messages"],
          method: "GET",
        },
        {
          id: "get_message",
          name: "Read email message",
          description: "Retrieve a specific email message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*",
          aliasPatterns: ["/v1.0/users/*/messages/*"],
          method: "GET",
        },
        {
          id: "list_mail_folders",
          name: "List mail folders",
          description: "List mail folders in the mailbox",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/mailFolders",
          aliasPatterns: ["/v1.0/users/*/mailFolders"],
          method: "GET",
        },
        {
          id: "list_folder_messages",
          name: "List folder messages",
          description: "List messages in a specific mail folder",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/mailFolders/*/messages",
          aliasPatterns: ["/v1.0/users/*/mailFolders/*/messages"],
          method: "GET",
        },
        {
          id: "list_events",
          name: "List calendar events",
          description: "List events on the user's calendar",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events",
          aliasPatterns: ["/v1.0/users/*/events"],
          method: "GET",
        },
        {
          id: "get_event",
          name: "Read calendar event",
          description: "Retrieve a specific calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          aliasPatterns: ["/v1.0/users/*/events/*"],
          method: "GET",
        },
        {
          id: "get_calendar_view",
          name: "View calendar range",
          description: "List events within a date range",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/calendarView",
          aliasPatterns: ["/v1.0/users/*/calendarView"],
          method: "GET",
        },
        {
          id: "list_calendars",
          name: "List calendars",
          description: "List the user's calendars",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/calendars",
          aliasPatterns: ["/v1.0/users/*/calendars"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "send_mail",
          name: "Send email",
          description: "Send an email message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/sendMail",
          aliasPatterns: ["/v1.0/users/*/sendMail"],
          method: "POST",
        },
        {
          id: "create_draft",
          name: "Create draft",
          description: "Create a draft email message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages",
          aliasPatterns: ["/v1.0/users/*/messages"],
          method: "POST",
        },
        {
          id: "update_message",
          name: "Update email message",
          description: "Update a message (flags, read state, drafts)",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*",
          aliasPatterns: ["/v1.0/users/*/messages/*"],
          method: "PATCH",
        },
        {
          id: "delete_message",
          name: "Delete email message",
          description: "Delete an email message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*",
          aliasPatterns: ["/v1.0/users/*/messages/*"],
          method: "DELETE",
        },
        {
          id: "move_message",
          name: "Move email message",
          description: "Move a message to another folder",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*/move",
          aliasPatterns: ["/v1.0/users/*/messages/*/move"],
          method: "POST",
        },
        {
          id: "reply_message",
          name: "Reply to email",
          description: "Reply to the sender of a message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*/reply",
          aliasPatterns: ["/v1.0/users/*/messages/*/reply"],
          method: "POST",
        },
        {
          id: "reply_all_message",
          name: "Reply all to email",
          description: "Reply to all recipients of a message",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/messages/*/replyAll",
          aliasPatterns: ["/v1.0/users/*/messages/*/replyAll"],
          method: "POST",
        },
        {
          id: "create_event",
          name: "Create calendar event",
          description: "Create a new calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events",
          aliasPatterns: ["/v1.0/users/*/events"],
          method: "POST",
        },
        {
          id: "update_event",
          name: "Update calendar event",
          description: "Modify an existing calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          aliasPatterns: ["/v1.0/users/*/events/*"],
          method: "PATCH",
        },
        {
          id: "delete_event",
          name: "Delete calendar event",
          description: "Delete a calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          aliasPatterns: ["/v1.0/users/*/events/*"],
          method: "DELETE",
        },
        {
          id: "accept_event",
          name: "Accept invitation",
          description: "Accept a meeting invitation",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*/accept",
          aliasPatterns: ["/v1.0/users/*/events/*/accept"],
          method: "POST",
        },
        {
          id: "decline_event",
          name: "Decline invitation",
          description: "Decline a meeting invitation",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*/decline",
          aliasPatterns: ["/v1.0/users/*/events/*/decline"],
          method: "POST",
        },
        {
          id: "tentatively_accept_event",
          name: "Tentatively accept invitation",
          description: "Tentatively accept a meeting invitation",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*/tentativelyAccept",
          aliasPatterns: ["/v1.0/users/*/events/*/tentativelyAccept"],
          method: "POST",
        },
      ],
    },
  ],
};
```

- [ ] **Step 4: Register it**

In `packages/api/src/apps/app-permissions/index.ts`: add `import { microsoft365Permissions } from "./microsoft365";` alphabetically among the imports, and `register(microsoft365Permissions);` alongside the other `register(...)` calls.

- [ ] **Step 5: Run tests to verify they pass**

Run: `nrun pnpm --filter @onecli/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/apps/app-permissions/microsoft365.ts packages/api/src/apps/app-permissions/index.ts packages/api/src/apps/app-permissions/microsoft365.test.ts
git commit -m "feat(api): add Microsoft 365 permissions catalogue"
```

---

### Task 4: Gateway provider (Rust)

**Files:**

- Modify: `apps/gateway/src/apps.rs` — one `RefreshConfig` static (near `GOOGLE_REFRESH`, ~line 183), one `AppProvider` entry (append near the gmail entry, ~line 301, inside the same providers array), tests in the existing `mod tests` (~line 1731).

**Interfaces:**

- Consumes: existing `RefreshConfig`, `AppProvider`, `HostRule`, `HostPattern`, `AuthStrategy`, `TokenBodyFormat`, `ClientCredentialMethod` types; test helpers `provider_for_host`, `provider_for_host_and_path`, `build_app_injections`, `refresh_config`.
- Produces: provider id `"microsoft-365"` resolvable by the gateway for host `graph.microsoft.com`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `apps/gateway/src/apps.rs` (follow the "── Todoist ──" section style):

```rust
    // ── Microsoft 365 ─────────────────────────────────────────────────

    #[test]
    fn provider_for_host_microsoft365() {
        let result = provider_for_host("graph.microsoft.com");
        assert_eq!(result, Some(("microsoft-365", "Microsoft 365")));
    }

    #[test]
    fn microsoft365_matches_any_graph_path() {
        // Dedicated host, no path-scoped rules — host-only fallback applies.
        for path in ["/v1.0/me/messages", "/v1.0/me/events/abc", "/v1.0/me"] {
            assert_eq!(
                provider_for_host_and_path("graph.microsoft.com", path),
                Some(("microsoft-365", "Microsoft 365")),
                "path {path} should resolve to microsoft-365"
            );
        }
    }

    #[test]
    fn microsoft365_uses_bearer() {
        let injections =
            build_app_injections("microsoft-365", "graph.microsoft.com", "ms_token_abc");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ms_token_abc".to_string(),
            }
        );
    }

    #[test]
    fn microsoft365_refresh_config() {
        let config =
            refresh_config("microsoft-365").expect("microsoft-365 should have refresh config");
        assert_eq!(
            config.token_url,
            "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        );
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(config.client_auth, ClientCredentialMethod::Body));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `crun cargo test microsoft365`
Expected: FAIL (provider not found / assertions on `None`).

- [ ] **Step 3: Implement**

In `apps/gateway/src/apps.rs`, next to `GOOGLE_REFRESH` (~line 183) add:

```rust
/// Refresh config for Microsoft identity platform v2.0 (Graph APIs).
/// `scope` is intentionally omitted on refresh — the endpoint re-issues the
/// originally consented scopes. Microsoft rotates refresh tokens; the rotated
/// token is returned by `refresh_access_token` and persisted by the caller.
static MICROSOFT_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    client_id_env: "MICROSOFT_CLIENT_ID",
    client_secret_env: "MICROSOFT_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};
```

In the providers array, after the `gmail` entry (~line 332), add:

```rust
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
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `crun cargo test microsoft365`
Expected: 4 tests PASS. Then run the full suite: `crun cargo test`
Expected: PASS (confirms no host-matching regressions).

- [ ] **Step 5: Format + clippy**

Run: `crun cargo fmt` then `crun cargo clippy -- -D warnings`
Expected: no diff beyond your changes, clippy clean.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/apps.rs
git commit -m "feat(gateway): add microsoft-365 provider for Microsoft Graph"
```

---

### Task 5: Icon and gateway skill text

**Files:**

- Create: `apps/web/public/icons/microsoft-365.svg`
- Modify: `packages/api/src/lib/skills/gateway-skill.ts` (example + browser-nag line)

**Interfaces:**

- Consumes: icon path `/icons/microsoft-365.svg` referenced by Task 2's app definition.
- Produces: nothing downstream.

- [ ] **Step 1: Create the icon**

Create `apps/web/public/icons/microsoft-365.svg` (Microsoft four-square mark, matches the flat style of the existing icons):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23">
  <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
  <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
  <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
  <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
</svg>
```

- [ ] **Step 2: Update the gateway skill prose**

In `packages/api/src/lib/skills/gateway-skill.ts`:

1. In the "Making Requests" example block (contains the `gmail.googleapis.com` curl), add after the gmail line:

```
curl -s "https://graph.microsoft.com/v1.0/me/messages?%24top=5"
```

(`%24` is a URL-encoded `$` — Graph accepts it, and it sidesteps both TS template-literal and shell `$` escaping in the example).

2. Change the line `- **Never** suggest the user open Gmail/Calendar/GitHub in their browser` to `- **Never** suggest the user open Gmail/Outlook/Calendar/GitHub in their browser`.

- [ ] **Step 3: Verify types/lint still clean**

Run: `nrun pnpm --filter @onecli/api lint && nrun pnpm --filter @onecli/api check-types`
Expected: clean.

- [ ] **Step 4: Visual check of the card**

Optional but cheap: `nrun pnpm dev` won't work well containerized for a quick look; instead just confirm the icon renders by opening the SVG file. The full card check happens in Task 6's E2E.

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/icons/microsoft-365.svg packages/api/src/lib/skills/gateway-skill.ts
git commit -m "feat: add Microsoft 365 icon and gateway skill guidance"
```

---

### Task 6: Full verification + deployment/E2E checklist

**Files:**

- No new code. Verification + docs only.
- Modify (only if drift found): any file failing checks.

- [ ] **Step 1: Full containerized check**

```bash
nrun pnpm check          # turbo lint + types + format across JS packages
nrun pnpm --filter @onecli/api test
crun cargo test
crun cargo clippy -- -D warnings
```

Expected: all clean. Fix and amend into the relevant commit if not.

- [ ] **Step 2: Grep for leftovers**

```bash
grep -rn "outlook-mail\|outlook-calendar" --include="*.ts" --include="*.tsx" packages apps | grep -v node_modules
```

Expected: no hits outside `.claude/worktrees/` (stale agent worktree copies are fine). If hits appear in `connect` fixtures or route code, update them and commit `fix: remove remaining outlook placeholder references`.

- [ ] **Step 3: Manual prerequisite — Azure App Registration (USER ACTION)**

Cannot be automated; needed before E2E:

1. portal.azure.com → App registrations → New registration.
2. Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"**.
3. Web redirect URI: the deployment's existing app-connect OAuth callback URL (same one the Google apps use — check the Google Cloud Console entry or the connect route if unsure).
4. Certificates & secrets → new client secret.
5. API permissions → Microsoft Graph → Delegated: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `offline_access`, `openid`, `email`, `profile`.
6. Set `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` in: local `.env`, and the deployment secret sets used for the web app AND the gateway (both read them — web for connect/BYOC-default, gateway for refresh). All infra changes go through CDK/GitHub Actions per repo policy, never direct AWS edits.

- [ ] **Step 4: Manual E2E**

1. Dashboard → Connections: "Microsoft 365" card shows with Connect button (no Team badge); outlook placeholder cards are gone.
2. Connect with the personal Microsoft account; verify the connection shows the account email as its label metadata.
3. Through the gateway: `curl -s "https://graph.microsoft.com/v1.0/me/messages?\$top=3"` → returns messages.
4. Refresh: force-expire the token (or wait >1h) and repeat step 3 → succeeds; confirm the stored refresh token rotated (rotation is expected with Microsoft).
5. Policy: add a block rule for `POST /v1.0/me/sendMail` on `graph.microsoft.com`, attempt a send through the gateway → 403 policy block.

- [ ] **Step 5: Wrap up**

Record any spec deviations found during E2E in the spec doc, commit, then use superpowers:finishing-a-development-branch to merge/PR `feat/microsoft-365-integration`.
