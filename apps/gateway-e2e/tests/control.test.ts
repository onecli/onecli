import { describe, expect } from "vitest";

import { addSecret, grantSecret } from "../src/fixtures.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

const SECRET = "sk-e2e-cache-busted";

const authed = (apiKey: string): RequestInit => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
});

describe("cache invalidation", () => {
  scenario("busts the connect cache so a new secret lands", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    // 1. Populate the cache with a resolution that has no credential in it.
    const cold = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });
    expect(cold.status).toBe(200);
    expect((await upstream.waitForRequests(1))[0]?.header("x-test-key")).toBe(
      undefined,
    );

    // 2. Add the credential AND its grant (step 7: nothing injects without
    //    one — this is the pair a production attach writes). The cache entry
    //    has a 60s TTL, so the gateway must still serve the stale resolution.
    await addSecret(cx.db.prisma, cx.ids, {
      hostPattern: "127.0.0.1",
      headerName: "x-test-key",
      value: SECRET,
    });
    await grantSecret(cx.db.prisma, cx.ids);
    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });
    expect((await upstream.waitForRequests(2))[1]?.header("x-test-key")).toBe(
      undefined,
    );

    // 3. Invalidate, and the very next request picks the credential up.
    const invalidated = await fetch(
      `${gw.origin}/v1/cache/invalidate`,
      authed(cx.ids.apiKey),
    );
    expect(invalidated.status).toBe(200);
    expect(await invalidated.json()).toMatchObject({ invalidated: true });

    await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // Step 2 is what makes step 3 meaningful: without it a gateway that never
    // cached at all would look identical to one whose invalidation works.
    // Together they pin the cache key, its prefix, and the org-id resolution
    // that builds it — the last of which degrades to an empty string on error
    // and would silently delete nothing.
    expect((await upstream.waitForRequests(3))[2]?.header("x-test-key")).toBe(
      SECRET,
    );
  });

  scenario("rejects invalidation without a key", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/v1/cache/invalidate`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });
});

describe("control-plane routes", () => {
  scenario("returns the caller's id from /me", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/me`, {
      headers: { authorization: `Bearer ${cx.ids.apiKey}` },
    });

    expect(res.status).toBe(200);
    // Deliberately a bare string, not JSON. Worth pinning precisely because a
    // tidy-up pass that "makes every endpoint return JSON" would break every
    // existing caller without failing to compile.
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(cx.ids.user);
  });

  scenario("answers an unknown vault provider consistently", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/v1/vault/not-a-provider/pair`, {
      ...authed(cx.ids.apiKey),
      // Provider-specific params. The body must parse before the handler runs,
      // or the rejection under test is never reached.
      body: "{}",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "unknown vault provider: not-a-provider",
    });
  });

  scenario("allows the dashboard's preflight headers", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const origin = "http://127.0.0.1:10254";
    const res = await fetch(`${gw.origin}/v1/vault/bitwarden/status`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-workspace-id, x-project-id",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // `x-workspace-id` is how the dashboard scopes a vault call to the active
    // workspace. Dropping it from the allow-list breaks that dialog in the
    // browser only — no server-side test would notice.
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "x-workspace-id",
    );
    // Rename compat: pre-rename browser callers still send x-project-id; a
    // missing allow-list entry blocks them client-side with no server log.
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "x-project-id",
    );
  });

  scenario("keeps the legacy X-Project-Id scope header working", async (cx) => {
    await cx.seed({ withOrgApiKey: true });
    const gw = await cx.startGateway();

    // Released clients scope an org key with X-Project-Id — the rename compat
    // must resolve it exactly like X-Workspace-Id, through the same org fence.
    const legacy = await fetch(`${gw.origin}/v1/cache/invalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cx.ids.orgApiKey}`,
        "content-type": "application/json",
        "x-project-id": cx.ids.workspace,
      },
    });
    expect(legacy.status).toBe(200);

    // A canonical header always wins: the legacy value here would fail the
    // org fence, so a 200 proves it was never read.
    const canonicalWins = await fetch(`${gw.origin}/v1/cache/invalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cx.ids.orgApiKey}`,
        "content-type": "application/json",
        "x-workspace-id": cx.ids.workspace,
        "x-project-id": "ws-that-does-not-exist",
      },
    });
    expect(canonicalWins.status).toBe(200);

    // No scope input at all: the 401 names both header generations, so the
    // old CLI's string-matched remediation hint still fires.
    const missing = await fetch(`${gw.origin}/v1/cache/invalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cx.ids.orgApiKey}`,
        "content-type": "application/json",
      },
    });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toContain("formerly X-Project-Id");
  });

  scenario("keeps the legacy /api aliases byte-compatible", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    // Both are pure compatibility shims for shipped CLI and SDK versions.
    // Deleting either compiles fine and breaks those clients silently, so the
    // only thing holding them in place is an assertion like this one.
    const [modern, legacy] = await Promise.all([
      fetch(`${gw.origin}/v1/cache/invalidate`, authed(cx.ids.apiKey)),
      fetch(`${gw.origin}/api/cache/invalidate`, authed(cx.ids.apiKey)),
    ]);

    // Pinned before the comparison: two routes that had both been deleted would
    // agree on 404 and satisfy the equality below without either working.
    expect(modern.status).toBe(200);
    expect(legacy.status).toBe(modern.status);
    expect(await legacy.text()).toBe(await modern.text());
  });
});

/**
 * Org-level app availability: with the org in `restricted` mode and no
 * availability grants seeded, every identifiable provider is blocked.
 *
 * Both tests carry the same block rule, so the only variable is the org's mode
 * — and, just as importantly, neither ever reaches the network. `gmail`
 * resolves for real, so a test that let the request through would silently
 * start calling Google; the block rule guarantees the gateway answers first
 * either way, and the differing error tells us which gate fired.
 */
const GMAIL_URL = "http://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_BLOCKED = {
  rules: [
    {
      name: "block-gmail",
      action: "block" as const,
      targets: [{ hostPattern: "gmail.googleapis.com" }],
    },
  ],
};

describe("app availability", () => {
  scenario("blocks a provider the org has not made available", async (cx) => {
    await cx.seed({ ...GMAIL_BLOCKED, appAvailabilityMode: "restricted" });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: GMAIL_URL,
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
    expect(res.header("x-should-retry")).toBe("false");
    // Availability is checked ahead of policy, so it wins over the block rule
    // — which also pins that ordering.
    expect(res.json()).toMatchObject({
      error: "app_unavailable",
      provider: "gmail",
      host: "gmail.googleapis.com",
    });
  });

  scenario("leaves the gate inert when the org is open", async (cx) => {
    await cx.seed({ ...GMAIL_BLOCKED, appAvailabilityMode: "open" });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: GMAIL_URL,
      token: cx.ids.agentToken,
    });

    // The negative control: same request, same rule, `open` instead of
    // `restricted`. The availability gate contributes nothing and the ordinary
    // block rule answers instead. Without this, a gateway that rejected every
    // provider request outright would pass the test above.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-gmail",
    });
  });
});
