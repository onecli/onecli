import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── The enterprise lock, proven feature by feature ─────────────────────────
//
// One row per probe: unlicensed → the license refusal; licensed → anything
// but it (the request proceeds into auth/validation — a 401 or a validation
// error proves the LICENSE gate specifically stood down). Cloud needs no
// third arm here: `parseEntitled` forces cloud entitled (see
// entitlements.test.ts), so cloud takes exactly the licensed path asserted
// below — and the CI cloud lane runs this whole suite under EDITION=cloud.
//
// The suite asserts its own COMPLETENESS: every `ENTERPRISE_FEATURES` key
// must be covered by at least one probe (or an explicit gateway-side
// pointer), so a future enterprise feature added without a lock fails here
// rather than shipping open.

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
  process.env.OAUTH_STATE_SECRET ??= "test-secret";
});

// Minimal db double: the service probes below assert BEFORE any query except
// the two counted reads multi-org needs and the licensed arms' first
// post-license reads (SCIM's /Users list, provisioning's expired-provision
// sweep); everything else must never reach it.
const store = vi.hoisted(() => ({ ownedOrgs: 2 }));
vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationMember: {
      count: async () => store.ownedOrgs,
      findUnique: async () => ({ role: "owner", status: "active" }),
      // The SCIM licensed-arm probe walks the real /Users handler.
      findMany: async () => [],
    },
    // provisionUser's licensed arm sweeps expired provisions before the seat
    // cap; empty keeps the sweep a clean no-op (its failures print).
    userProvision: { findMany: async () => [] },
    organizationScimToken: {
      findUnique: async () => ({
        id: "tok-1",
        organizationId: "org-1",
        label: "test",
        revokedAt: null,
      }),
      update: async () => ({}),
    },
  },
}));

import {
  ENTERPRISE_FEATURES,
  initEntitlementForTests,
  type EnterpriseFeature,
} from "../lib/entitlements";
import { EDITION_INFO } from "../lib/env";
import { enterpriseLicenseMessage } from "../lib/entitlements-guard";
import { orgAppAvailabilityRoutes } from "../ee/routes/org-app-availability";
import { orgDomainRoutes } from "../ee/routes/org-domains";
import { orgSsoConnectionRoutes } from "../ee/routes/org-sso-connections";
import { orgSsoEnforcementRoutes } from "../ee/routes/org-sso-enforcement";
import { orgScimTokenRoutes } from "../ee/routes/org-scim-tokens";
import { orgMemberRoutes } from "../ee/routes/org-members";
import { orgGroupRoutes } from "../ee/routes/org-groups";
import { orgRoleMappingRoutes } from "../ee/routes/org-role-mappings";
import { dropboxFolderRoutes } from "../ee/routes/dropbox-folders";
import { teamRoutes } from "../ee/routes/team";
import { provisionClaimRoutes } from "../ee/routes/provision-claim";
import { workspaceAccessRoutes } from "../ee/routes/workspace-access";
import { ssoLookupRoutes } from "../ee/routes/sso-lookup";
import { setBudget } from "../ee/budget";
import { createScimApp } from "../ee/scim/app";
import {
  assertCanCreateOrganization,
  assertCanShareWorkspace,
  assertCanUseGranularAccess,
} from "../ee/services/quota-service";
import { deleteOrganization } from "../ee/services/organization-service";
import {
  claimProvision,
  provisionUser,
} from "../ee/services/user-provision-service";
import {
  changeMemberRole,
  setMemberSsoExempt,
} from "../ee/services/team-service";
import { getRuleActionGate } from "../providers/hooks/rule-action-gate";
import { getPolicyValidator } from "../providers/hooks/policy-validator";
import { initSession } from "../providers";

// Licensed route probes proceed past the gate into real session auth. A
// null-session provider lands them on the clean 401 promised above — without
// it every licensed arm dies on an uninitialized-provider throw instead.
initSession({ getSession: async () => null });

const LICENSE_TYPE = "enterprise_license_required";

const onpremLane = EDITION_INFO.edition === "onprem";

/** Any Hono app, whatever its Env — the probes only need `.request()`. */
interface Requestable {
  request: (path: string) => Response | Promise<Response>;
}

/** GET `path` on a freshly-built router and report how the gate answered. */
const probeRoute =
  (build: () => Requestable, path = "/") =>
  async () => {
    const res = await build().request(path);
    if (res.status !== 403) return { refused: false, status: res.status };
    const body = (await res.json().catch(() => null)) as {
      error?: { type?: string };
    } | null;
    return { refused: body?.error?.type === LICENSE_TYPE, status: 403 };
  };

/** Run `fn` and report whether it threw the license refusal for `feature`. */
const probeService =
  (feature: EnterpriseFeature, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      return { refused: false, status: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        refused: message === enterpriseLicenseMessage(feature),
        status: 403,
      };
    }
  };

interface Probe {
  feature: EnterpriseFeature;
  name: string;
  run: () => Promise<{ refused: boolean }>;
  /** Probes the ONPREM provider-slot default, which only exists on the
   * onprem lane — the cloud lane deliberately fail-louds on an uninjected
   * slot, and unlicensed cloud is not a real state (parseEntitled forces
   * cloud entitled). */
  onpremOnly?: boolean;
}

/**
 * A key whose lock lives in the gateway binary. The pointer is VERIFIED, not
 * prose: completeness reads `file` and asserts `testName` still exists, so
 * renaming or deleting the named gateway test fails this suite.
 */
interface GatewayCovered {
  feature: EnterpriseFeature;
  file: string;
  testName: string;
  /** Extra coverage context, informational only. */
  also?: string;
}

// Resolved from this file's location — never `git rev-parse`, which the
// pre-push hook's GIT_DIR poisons in worktrees (see invitations-free).
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const PROBES: Probe[] = [
  // ── Route surfaces (blanket requireEnterprise; refuses before auth/DB) ──
  {
    feature: "app_availability",
    name: "app availability router",
    run: probeRoute(orgAppAvailabilityRoutes),
  },
  { feature: "sso", name: "domains router", run: probeRoute(orgDomainRoutes) },
  {
    feature: "sso",
    name: "sso connections router",
    run: probeRoute(orgSsoConnectionRoutes),
  },
  {
    feature: "sso",
    name: "sso enforcement router",
    run: probeRoute(orgSsoEnforcementRoutes),
  },
  {
    feature: "sso",
    name: "scim tokens router",
    run: probeRoute(orgScimTokenRoutes),
  },
  {
    feature: "sso",
    name: "sso lookup router",
    run: probeRoute(ssoLookupRoutes, "/lookup"),
  },
  {
    feature: "members_directory",
    name: "org members router",
    run: probeRoute(orgMemberRoutes),
  },
  { feature: "groups", name: "groups router", run: probeRoute(orgGroupRoutes) },
  {
    feature: "groups",
    name: "role mappings router",
    run: probeRoute(orgRoleMappingRoutes),
  },
  {
    feature: "granular_access",
    name: "dropbox folders router",
    run: probeRoute(dropboxFolderRoutes, "/folders"),
  },
  {
    feature: "provisioning",
    name: "team provisioning router",
    run: probeRoute(teamRoutes, "/provisions"),
  },
  {
    feature: "provisioning",
    name: "provision claim router",
    run: probeRoute(provisionClaimRoutes, "/claim"),
  },
  {
    feature: "workspace_sharing",
    name: "workspace access router",
    run: probeRoute(workspaceAccessRoutes, "/p-1/access"),
  },

  // ── Service / provider gates (the web-server-action bypass paths) ──
  {
    feature: "multi_org",
    name: "assertCanCreateOrganization clamps to one org",
    run: probeService("multi_org", () => assertCanCreateOrganization("user-1")),
  },
  {
    feature: "multi_org",
    name: "deleteOrganization frozen while owning several",
    run: probeService("multi_org", () => deleteOrganization("org-1", "user-1")),
  },
  {
    feature: "provisioning",
    name: "provisionUser",
    run: probeService("provisioning", () =>
      provisionUser({
        organizationId: "org-1",
        role: "member",
        provisionedById: "user-1",
        provisionedByEmail: "a@example.com",
        appUrl: "http://localhost",
      }),
    ),
  },
  {
    feature: "provisioning",
    name: "claimProvision (links minted while licensed die too)",
    run: probeService("provisioning", () =>
      claimProvision("tok", "user-2", "b@example.com", "auth-2"),
    ),
  },
  {
    feature: "workspace_sharing",
    name: "assertCanShareWorkspace",
    run: probeService("workspace_sharing", () =>
      assertCanShareWorkspace("org-1"),
    ),
  },
  {
    feature: "granular_access",
    name: "assertCanUseGranularAccess",
    run: probeService("granular_access", () =>
      assertCanUseGranularAccess("org-1"),
    ),
  },
  {
    feature: "granular_access",
    name: "policy validator refuses session-policy saves",
    onpremOnly: true,
    run: probeService("granular_access", () =>
      getPolicyValidator().validate("org-1", "github-app", null, {
        repositories: ["org/repo"],
      }),
    ),
  },
  {
    feature: "budget",
    name: "budget service refuses writes (dormant module, gated at the service)",
    run: probeService("budget", () =>
      setBudget(
        "org-1",
        "sec-1",
        { limitCents: 500, period: "monthly" },
        "u-1",
      ),
    ),
  },
  {
    feature: "groups",
    name: "rule-action gate refuses group identity targeting",
    onpremOnly: true,
    run: probeService("groups", () =>
      getRuleActionGate().assertAllowed({ organizationId: "org-1" }, [
        "identity_directory_group",
      ]),
    ),
  },
  {
    feature: "rbac",
    name: "changeMemberRole",
    run: probeService("rbac", () =>
      changeMemberRole("org-1", "user-2", "admin"),
    ),
  },
  {
    feature: "sso",
    name: "setMemberSsoExempt",
    run: probeService("sso", () => setMemberSsoExempt("org-1", "user-2", true)),
  },
];

// SCIM's data plane answers a deliberately hint-free 401 (§7.1) instead of the
// license shape, so it gets its own probe. An OBJECT carrying its feature key:
// the completeness set below derives "sso" from here, so deleting this probe
// (and its describe) breaks completeness instead of leaving a stale claim.
const scimDataPlaneProbe = {
  feature: "sso" as const satisfies EnterpriseFeature,
  run: async (): Promise<{ refused: boolean }> => {
    const res = await createScimApp().request("/Users", {
      headers: { authorization: "Bearer oc_scim_test" },
    });
    return { refused: res.status === 401 };
  },
};

const GATEWAY_COVERED: GatewayCovered[] = [
  {
    feature: "ha",
    file: "apps/gateway/crates/ee/ee/src/ha.rs",
    testName: "ha_entitlement_check_is_table_driven",
    also: "the unlicensed e2e lane (apps/gateway-e2e/tests/unlicensed.test.ts) proves the startup bail black-box",
  },
];

describe("the enterprise lock, feature by feature", () => {
  afterEach(() => initEntitlementForTests(null));

  it("covers every enterprise feature key (completeness)", () => {
    const covered = new Set<string>([
      ...PROBES.map((p) => p.feature),
      scimDataPlaneProbe.feature,
      ...GATEWAY_COVERED.map((g) => g.feature),
    ]);
    // Every registry key must be proven. Adding an EnterpriseFeature without
    // a probe here means shipping an ungated enterprise feature — fail.
    expect([...covered].sort()).toEqual(
      Object.keys(ENTERPRISE_FEATURES).sort(),
    );
    // Gateway pointers are proof, not prose: the named test must still exist
    // in the named file AND still run there. A renamed/deleted test, or one
    // parked behind #[ignore], leaves the claim standing while nothing is
    // proven — so both are failures.
    for (const g of GATEWAY_COVERED) {
      const source = readFileSync(join(repoRoot, g.file), "utf8");
      expect(
        source,
        `${g.file} no longer contains ${g.testName} — the ${g.feature} lock lost its gateway proof`,
      ).toContain(g.testName);
      expect(
        source,
        `${g.file} contains #[ignore] — a parked test proves nothing for the ${g.feature} lock`,
      ).not.toContain("#[ignore]");
    }
  });

  describe.each(PROBES.map((p) => [`${p.feature} · ${p.name}`, p] as const))(
    "%s",
    (_label, probe) => {
      it.skipIf(probe.onpremOnly && !onpremLane)(
        "refuses unlicensed",
        async () => {
          initEntitlementForTests(false);
          const result = await probe.run();
          expect(result.refused, "expected the license refusal").toBe(true);
        },
      );

      it.skipIf(probe.onpremOnly && !onpremLane)(
        "stands down licensed",
        async () => {
          initEntitlementForTests(true);
          const result = await probe.run();
          expect(
            result.refused,
            "the license gate must not fire when entitled",
          ).toBe(false);
        },
      );
    },
  );

  describe("sso · SCIM data plane (hint-free 401, per-request recheck)", () => {
    it("kills a valid token unlicensed", async () => {
      initEntitlementForTests(false);
      expect((await scimDataPlaneProbe.run()).refused).toBe(true);
    });

    it("the same token proceeds licensed", async () => {
      initEntitlementForTests(true);
      const res = await createScimApp().request("/Users", {
        headers: { authorization: "Bearer oc_scim_test" },
      });
      // Past scimAuth (the mocked token resolves) — any answer but the
      // auth-layer 401 proves the entitlement recheck stood down.
      expect(res.status).not.toBe(401);
    });
  });
});
