import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connection: null as {
    id: string;
    organizationId: string;
    cognitoProviderName: string;
  } | null,
  connectionQueries: [] as Record<string, unknown>[],
  domainRow: null as
    | { organizationId: string; organization?: { ssoRequired: boolean } }
    | { id: string }
    | null,
  domainQueries: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationSsoConnection: {
      findFirst: async (args: Record<string, unknown>) => {
        state.connectionQueries.push(args);
        return state.connection;
      },
    },
    organizationDomain: {
      findFirst: async (args: Record<string, unknown>) => {
        state.domainQueries.push(args);
        return state.domainRow;
      },
    },
  },
}));

import { findSsoOrgForIdentity, lookupSsoForEmail } from "./sso-trust";
import { initEntitlementForTests } from "../../lib/entitlements";

const PROVIDER = "org-0f9b2c4d6e8a0b1c2d3e4f5a";

beforeEach(() => {
  state.connection = null;
  state.connectionQueries = [];
  state.domainRow = null;
  state.domainQueries = [];
  // The trust logic under test is licensed behavior; the hermetic test env
  // is unlicensed by default and the gate would null everything out. The
  // unlicensed arm flips this off explicitly.
  initEntitlementForTests(true);
});

afterEach(() => initEntitlementForTests(null));

describe("findSsoOrgForIdentity", () => {
  it("resolves when the provider is live and the email domain is verified for the same org", async () => {
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };
    state.domainRow = { id: "dom-1" };

    await expect(
      findSsoOrgForIdentity([PROVIDER], "guy@acme.com"),
    ).resolves.toEqual({
      organizationId: "org-1",
      connectionId: "conn-1",
      cognitoProviderName: PROVIDER,
    });
    // The domain leg is scoped to the CONNECTION's org — the cross-org guard.
    expect(state.domainQueries[0]).toMatchObject({
      where: {
        organizationId: "org-1",
        domain: "acme.com",
        verifiedAt: { not: null },
      },
    });
  });

  it("matches provider names case-insensitively (tokens may recase them)", async () => {
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };
    state.domainRow = { id: "dom-1" };

    await findSsoOrgForIdentity([PROVIDER.toUpperCase()], "guy@acme.com");
    expect(state.connectionQueries[0]).toMatchObject({
      where: { cognitoProviderName: { in: [PROVIDER] } },
    });
  });

  it("costs zero queries for non-SSO sessions (prefix gate first)", async () => {
    await expect(
      findSsoOrgForIdentity(["Google"], "guy@acme.com"),
    ).resolves.toBeNull();
    await expect(findSsoOrgForIdentity([], "guy@acme.com")).resolves.toBeNull();
    expect(state.connectionQueries).toHaveLength(0);
    expect(state.domainQueries).toHaveLength(0);
  });

  it("unlicensed: the would-succeed fixture resolves null and runs ZERO trust queries", async () => {
    // The exact fixture the happy-path test resolves with — only the license
    // flag differs, so a vouch here can only mean the gate is gone.
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };
    state.domainRow = { id: "dom-1" };
    initEntitlementForTests(false);

    await expect(
      findSsoOrgForIdentity([PROVIDER], "guy@acme.com"),
    ).resolves.toBeNull();
    // The skips-queries posture: EE data present, flag off ⇒ no EE reads.
    expect(state.connectionQueries).toHaveLength(0);
    expect(state.domainQueries).toHaveLength(0);

    // Positive control: the same fixture vouches again once licensed.
    initEntitlementForTests(true);
    await expect(
      findSsoOrgForIdentity([PROVIDER], "guy@acme.com"),
    ).resolves.toMatchObject({ organizationId: "org-1" });
  });

  it("returns null without a live connection row", async () => {
    await expect(
      findSsoOrgForIdentity([PROVIDER], "guy@acme.com"),
    ).resolves.toBeNull();
    // Disabled connections are excluded by the query itself.
    expect(state.connectionQueries[0]).toMatchObject({
      where: { status: { not: "disabled" } },
    });
  });

  it("returns null when the org has not verified the email's domain", async () => {
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };
    state.domainRow = null;
    await expect(
      findSsoOrgForIdentity([PROVIDER], "guy@other.com"),
    ).resolves.toBeNull();
  });

  it("returns null for emails without a usable domain", async () => {
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };
    await expect(
      findSsoOrgForIdentity([PROVIDER], "not-an-email"),
    ).resolves.toBeNull();
    await expect(
      findSsoOrgForIdentity([PROVIDER], "user@localhost"),
    ).resolves.toBeNull();
    expect(state.connectionQueries).toHaveLength(0);
  });
});

describe("lookupSsoForEmail", () => {
  it("maps a verified domain to its org's live connection", async () => {
    state.domainRow = {
      organizationId: "org-1",
      organization: { ssoRequired: false },
    };
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };

    await expect(lookupSsoForEmail("Guy@ACME.com")).resolves.toEqual({
      provider: PROVIDER,
      enforced: false,
    });
    expect(state.domainQueries[0]).toMatchObject({
      where: { domain: "acme.com", verifiedAt: { not: null } },
    });
  });

  it("carries the org's require-SSO flag as `enforced`", async () => {
    state.domainRow = {
      organizationId: "org-1",
      organization: { ssoRequired: true },
    };
    state.connection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: PROVIDER,
    };

    await expect(lookupSsoForEmail("guy@acme.com")).resolves.toEqual({
      provider: PROVIDER,
      enforced: true,
    });
  });

  it("returns null for unknown domains, missing connections, and invalid emails", async () => {
    await expect(lookupSsoForEmail("guy@unknown.com")).resolves.toBeNull();

    state.domainRow = {
      organizationId: "org-1",
      organization: { ssoRequired: false },
    };
    state.connection = null;
    await expect(lookupSsoForEmail("guy@acme.com")).resolves.toBeNull();

    await expect(lookupSsoForEmail("garbage")).resolves.toBeNull();
  });
});
