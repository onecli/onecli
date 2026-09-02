import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

// ── The unlicensed self-host lane ──────────────────────────────────────────
//
// Boots the REAL binary as an unlicensed onprem deployment (EDITION=onprem,
// no ENTERPRISE_ENABLED) and proves the decided posture from the outside:
// "when the ee flag is off, no EE behavior is left over, even if there is the
// data." Licensed features get a differential twin (same seeds, opposite
// outcome); org credentials are FREE, so their scenarios are parity twins —
// the license flag must change nothing.

/** Unlicensed onprem: overrides the harness's enterprise spawn env. */
const UNLICENSED = {
  env: {
    // The harness default is the ENTITLED self-host; blank the flag (the
    // parser treats a blank exactly like unset) to boot unlicensed.
    ENTERPRISE_ENABLED: "",
    // HA is licensed (#7): the unlicensed boot must run the in-memory stores.
    REDIS_HOST: "",
  },
  expectedEdition: "Onprem" as const,
};

/** The same deployment with the license flag on — the unlock differential.
 * REDIS_HOST stays blank so the pair differs ONLY in the flag. */
const LICENSED = {
  env: { ...UNLICENSED.env, ENTERPRISE_ENABLED: "true" },
  expectedEdition: "Onprem" as const,
};

const ORG_SECRET = "sk-e2e-org-value";
const WORKSPACE_SECRET = "sk-e2e-workspace-value";

const TIERED_SECRETS = {
  secrets: [
    {
      hostPattern: "127.0.0.1",
      headerName: "x-org-key",
      value: ORG_SECRET,
      scope: "organization" as const,
    },
    {
      hostPattern: "127.0.0.1",
      headerName: "x-proj-key",
      value: WORKSPACE_SECRET,
    },
  ],
  grantAll: true,
};

// An org-scoped connection whose resolution is observable WITHOUT a socket:
// the block rule stops the forward after connect-resolution, and the policy
// 403 advertises the resolved account choices via `x-onecli-connections`
// (the app-connections suite pins that contract).
const GMAIL_HOST = "gmail.googleapis.com";

const ORG_CONNECTION_WORLD = {
  grantAll: true,
  appConnections: [{ provider: "gmail", scope: "organization" as const }],
  rules: [
    {
      name: "block-gmail",
      action: "block" as const,
      targets: [{ hostPattern: GMAIL_HOST }],
    },
  ],
};

const GROUP_BLOCK = {
  rules: [
    {
      name: "group-block",
      action: "block" as const,
      scope: "organization" as const,
      identities: ["group"] as const,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

// A user-targeted rule naming a member whose ONLY workspace grant is a group
// membership. Licensed, the principal CTE inherits them (member of a granted
// group → a user principal); unlicensed, the free direct-user twin resolves
// direct WorkspaceAccess rows only, so the inheritance — group semantics —
// never happens (#51 tightening).
const INHERITED_USER_BLOCK = {
  rules: [
    {
      name: "inherited-user-block",
      action: "block" as const,
      scope: "organization" as const,
      identities: ["user-via-group"] as const,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

// The free-arm parity guard: the same user-targeted rule with a DIRECT grant.
const DIRECT_USER_BLOCK = {
  rules: [
    {
      name: "direct-user-block",
      action: "block" as const,
      scope: "organization" as const,
      identities: ["user"] as const,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

// The resource-boundary suite's disjoint composition (org allows acme/api,
// the workspace picks acme/secrets — overlap empty), plus the block rule
// that doubles as the no-egress guarantee and the unscoped-arm discriminator.
const GITHUB_HOST = "api.github.com";

const RESOURCE_SCOPE_WORLD = {
  appConnections: [{ provider: "github-app", label: "acme" }],
  rules: [
    {
      name: "org: allowed repositories",
      action: "allow" as const,
      scope: "organization" as const,
      targets: [{ kind: "connection" as const, connectionIndex: 0 }],
      resources: { repositories: ["acme/api"] },
    },
    {
      name: "grant: agent → connection",
      action: "allow" as const,
      source: "grant" as const,
      priority: 90,
      identities: ["agent" as const],
      targets: [{ kind: "connection" as const, connectionIndex: 0 }],
      resources: { repositories: ["acme/secrets"] },
    },
    {
      name: "block-github",
      action: "block" as const,
      targets: [{ hostPattern: GITHUB_HOST }],
    },
  ],
};

// An org-scope rule naming NO identities — "binds everyone" in decisions,
// the plain policy floor — free on every deployment today.
const ORG_FLOOR_WORLD = {
  secrets: [
    {
      hostPattern: "127.0.0.1",
      headerName: "x-proj-key",
      value: WORKSPACE_SECRET,
    },
  ],
  grantAll: true,
  rules: [
    {
      name: "org-floor-block",
      action: "block" as const,
      scope: "organization" as const,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

describe("unlicensed self-host (EDITION=onprem, no ENTERPRISE_ENABLED)", () => {
  scenario(
    "org secrets inject unlicensed, beside workspace secrets — org credentials are free",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(TIERED_SECRETS);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      // Both tiers inject: one org-level secret serves every workspace, on
      // every edition, with no license flag.
      expect(seen?.header("x-org-key")).toBe(ORG_SECRET);
      expect(seen?.header("x-proj-key")).toBe(WORKSPACE_SECRET);
    },
  );

  scenario(
    "the license flag changes nothing for org-secret injection",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(TIERED_SECRETS);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-org-key")).toBe(ORG_SECRET);
      expect(seen?.header("x-proj-key")).toBe(WORKSPACE_SECRET);
    },
  );

  scenario(
    "an org-scoped app connection resolves into the injection pool unlicensed",
    async (cx) => {
      await cx.seed(ORG_CONNECTION_WORLD);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: `http://${GMAIL_HOST}/gmail/v1/users/me`,
        token: cx.ids.agentToken,
      });

      // The block rule stops the request before any socket opens, and the
      // forward path advertises the resolved account choices — proving the
      // org-scoped connection entered the pool with no license flag.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
      const advertised = JSON.parse(
        res.header("x-onecli-connections") ?? "[]",
      ) as Array<{ id: string }>;
      expect(advertised.map((c) => c.id)).toEqual([
        `${cx.ids.workspace}-conn-0`,
      ]);
    },
  );

  scenario(
    "the license flag changes nothing for org-connection resolution",
    async (cx) => {
      await cx.seed(ORG_CONNECTION_WORLD);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: `http://${GMAIL_HOST}/gmail/v1/users/me`,
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
      const advertised = JSON.parse(
        res.header("x-onecli-connections") ?? "[]",
      ) as Array<{ id: string }>;
      expect(advertised.map((c) => c.id)).toEqual([
        `${cx.ids.workspace}-conn-0`,
      ]);
    },
  );

  scenario(
    "a group-bound BLOCK rule stops firing — the decided loosening (#51)",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(GROUP_BLOCK);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      });

      // The licensed lane (policy.test.ts) proves this same world blocks.
      // Unlicensed, group principals are never resolved (the free direct-user
      // twin runs instead of the licensed CTE), the rule's identity never
      // matches, and the request goes through — the console marks such rules
      // "Not enforced".
      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);
    },
  );

  scenario(
    "the license flag makes the same group rule enforce again",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(GROUP_BLOCK);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "group-block",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "a rule naming a group-INHERITED member stops matching — the #51 tightening",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(INHERITED_USER_BLOCK);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      });

      // The user's only grant is membership in a granted group — group
      // semantics, licensed. Unlicensed, the free direct-user twin resolves
      // no principals at all, so the user-targeted rule never matches. (Before
      // the tightening the full CTE ran and only group ids were discarded, so
      // this inherited USER still matched — enterprise inheritance surviving
      // the flag being off.)
      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);
    },
  );

  scenario(
    "the license flag restores group-inherited principals",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(INHERITED_USER_BLOCK);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "inherited-user-block",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "a DIRECTLY granted user still matches unlicensed — user targeting stays free",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(DIRECT_USER_BLOCK);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/anything"),
        token: cx.ids.agentToken,
      });

      // The over-removal guard: individual-user targeting is FREE, so the
      // direct-grant arm must keep enforcing with the flag off.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "direct-user-block",
      });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "a restricted availability posture is ignored — policy still decides (#29)",
    async (cx) => {
      await cx.seed({
        appAvailabilityMode: "restricted",
        rules: [
          {
            name: "block-gmail",
            action: "block",
            targets: [{ hostPattern: "gmail.googleapis.com" }],
          },
        ],
      });
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        token: cx.ids.agentToken,
      });

      // The licensed lane answers `app_unavailable` here (availability wins
      // over policy). Unlicensed, availability resolves as open without a
      // query — and the free policy engine still decides: the block rule.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-gmail",
      });
    },
  );

  scenario(
    "the org approvals feed answers the license 403 (#59)",
    async (cx) => {
      await cx.seed({ withApiKey: true });
      const gw = await cx.startGateway(UNLICENSED);

      const res = await fetch(`${gw.origin}/v1/org/approvals/pending`, {
        headers: { authorization: `Bearer ${cx.ids.apiKey}` },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "enterprise_license_required",
      });
    },
  );

  // ── The RBAC key-recheck skip (#66), proven end to end ────────────────────
  // enforce_key_rechecks(edition, entitled) is table-tested in auth.rs, but
  // nothing proved the CALL SITES stand down unlicensed: a mutation making the
  // recheck unconditional passed every test. The org approvals feed is the
  // wire-observable oracle — reaching its license 403 REQUIRES the org key to
  // have authenticated first.
  scenario(
    "an org key of a mere MEMBER authenticates unlicensed — the RBAC recheck stands down",
    async (cx) => {
      await cx.seed({ withOrgApiKey: true });
      // The seed makes the key's user an owner; the recheck differential
      // needs a non-admin.
      await cx.db.prisma.organizationMember.update({
        where: {
          organizationId_userId: {
            organizationId: cx.ids.org,
            userId: cx.ids.user,
          },
        },
        data: { role: "member" },
      });
      const gw = await cx.startGateway(UNLICENSED);

      const res = await fetch(`${gw.origin}/v1/org/approvals/pending`, {
        headers: { authorization: `Bearer ${cx.ids.orgApiKey}` },
      });

      // The license 403 — NOT a 401: the key authenticated (no admin
      // recheck), then the org surface answered with the license reason.
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "enterprise_license_required",
      });
    },
  );

  scenario(
    "the license flag re-arms the recheck: the same member key dies 401",
    async (cx) => {
      await cx.seed({ withOrgApiKey: true });
      await cx.db.prisma.organizationMember.update({
        where: {
          organizationId_userId: {
            organizationId: cx.ids.org,
            userId: cx.ids.user,
          },
        },
        data: { role: "member" },
      });
      const gw = await cx.startGateway(LICENSED);

      const res = await fetch(`${gw.origin}/v1/org/approvals/pending`, {
        headers: { authorization: `Bearer ${cx.ids.orgApiKey}` },
      });

      expect(res.status).toBe(401);
    },
  );

  // ── Resource scoping (#39/#40) unlicensed, end to end ─────────────────────
  // The resource-boundary suite proves the licensed composition; this twin
  // proves the flag-off arm outside the unit test: the same disjoint
  // org-boundary ∩ workspace-pick that is refused for scope when licensed
  // injects UNSCOPED unlicensed and falls through to the ordinary block rule.
  // Two distinct wire bodies say which arm ran; nothing ever leaves the box.
  scenario(
    "a seeded resource scope is IGNORED unlicensed — the credential injects unscoped",
    async (cx) => {
      await cx.seed(RESOURCE_SCOPE_WORLD);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: `http://${GITHUB_HOST}/repos/acme/api`,
        token: cx.ids.agentToken,
      });

      // Not the scope refusal — the ordinary policy block: the request
      // sailed PAST resource scoping (session policy stamped away).
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-github",
      });
    },
  );

  scenario(
    "the license flag makes the same seeds refuse for scope",
    async (cx) => {
      await cx.seed(RESOURCE_SCOPE_WORLD);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: `http://${GITHUB_HOST}/repos/acme/api`,
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        error: "resource_access_denied",
        allowed: [],
      });
    },
  );

  // ── The org policy floor is free — FREEZE the de-facto posture ────────────
  // Whether the org-scope floor should ever become licensed is an open
  // product question; until it is answered, these parity twins pin today's
  // shipped behavior so nobody gates the floor by accident: an org-scope
  // rule with NO identities binds everyone, flag on or off. (Only its
  // group-identity arms are licensed — the scenarios above.)
  scenario(
    "an org-scope block rule enforces unlicensed — the policy floor is free",
    async (cx) => {
      await cx.seed(ORG_FLOOR_WORLD);
      const gw = await cx.startGateway(UNLICENSED);

      const res = await throughProxy(gw.origin, {
        url: "http://127.0.0.1/anything",
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "org-floor-block",
      });
    },
  );

  scenario(
    "the license flag changes nothing for the org policy floor",
    async (cx) => {
      await cx.seed(ORG_FLOOR_WORLD);
      const gw = await cx.startGateway(LICENSED);

      const res = await throughProxy(gw.origin, {
        url: "http://127.0.0.1/anything",
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "org-floor-block",
      });
    },
  );

  scenario(
    "a Redis-configured unlicensed gateway refuses to start (#7)",
    async (cx) => {
      await cx.seed();
      // Point REDIS_HOST at the suite's real Redis: the process must die on
      // the entitlement check, not on a connection failure.
      await expect(
        cx.startGateway({
          env: { ...UNLICENSED.env, REDIS_HOST: cx.config.redisHost },
          expectedEdition: "Onprem",
        }),
      ).rejects.toThrow(/Enterprise license/);
    },
  );
});
