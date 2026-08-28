import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enforcedOrg: null as { organizationId: string } | null,
  domainQueries: [] as Record<string, unknown>[],
  membership: null as { ssoExempt: boolean } | null,
  membershipQueries: [] as Record<string, unknown>[],
  ssoOrg: null as { organizationId: string } | null,
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationDomain: {
      findFirst: async (args: Record<string, unknown>) => {
        state.domainQueries.push(args);
        return state.enforcedOrg;
      },
    },
    organizationMember: {
      findUnique: async (args: Record<string, unknown>) => {
        state.membershipQueries.push(args);
        return state.membership;
      },
    },
  },
}));

vi.mock("./sso-trust", () => ({
  findSsoOrgForIdentity: async () => state.ssoOrg,
}));

import {
  enforceSsoSession,
  SSO_REQUIRED_CODE,
  SSO_REQUIRED_ERROR,
} from "./sso-enforcement";

const SESSION = { id: "sub-1", email: "guy@acme.com" };
const USER = { id: "user-1", email: "guy@acme.com" };
const DENIAL = { error: SSO_REQUIRED_ERROR, code: SSO_REQUIRED_CODE };

beforeEach(() => {
  state.enforcedOrg = null;
  state.domainQueries = [];
  state.membership = null;
  state.membershipQueries = [];
  state.ssoOrg = null;
});

describe("enforceSsoSession", () => {
  it("allows emails without a usable domain, with zero queries", async () => {
    await expect(
      enforceSsoSession(SESSION, { id: "user-1", email: "garbage" }),
    ).resolves.toBeNull();
    expect(state.domainQueries).toHaveLength(0);
  });

  it("allows when the domain is not enforced (the one-query hot path)", async () => {
    await expect(enforceSsoSession(SESSION, USER)).resolves.toBeNull();
    expect(state.domainQueries[0]).toMatchObject({
      where: {
        domain: "acme.com",
        verifiedAt: { not: null },
        organization: { ssoRequired: true },
      },
    });
    expect(state.membershipQueries).toHaveLength(0);
  });

  it("allows a session that arrived through the enforcing org's own SSO", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    state.ssoOrg = { organizationId: "org-1" };
    await expect(
      enforceSsoSession(
        { ...SESSION, identityProviders: ["org-abc123"] },
        USER,
      ),
    ).resolves.toBeNull();
    expect(state.membershipQueries).toHaveLength(0);
  });

  it("rejects an SSO session from a DIFFERENT org (cross-org is not the enforcing org)", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    state.ssoOrg = { organizationId: "org-2" };
    await expect(
      enforceSsoSession({ ...SESSION, identityProviders: ["org-other"] }, USER),
    ).resolves.toEqual(DENIAL);
  });

  it("allows a break-glass exempt member on a non-SSO session", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    state.membership = { ssoExempt: true };
    await expect(enforceSsoSession(SESSION, USER)).resolves.toBeNull();
    expect(state.membershipQueries[0]).toMatchObject({
      where: {
        organizationId_userId: {
          organizationId: "org-1",
          userId: "user-1",
        },
      },
    });
  });

  it("rejects a non-exempt member on a non-SSO session", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    state.membership = { ssoExempt: false };
    await expect(enforceSsoSession(SESSION, USER)).resolves.toEqual(DENIAL);
  });

  it("rejects a NON-member with an enforced-domain email (domain-keyed by design)", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    state.membership = null;
    await expect(enforceSsoSession(SESSION, USER)).resolves.toEqual(DENIAL);
  });

  it("treats missing identityProviders as a non-SSO session", async () => {
    state.enforcedOrg = { organizationId: "org-1" };
    await expect(
      enforceSsoSession({ id: "sub-1", email: "guy@acme.com" }, USER),
    ).resolves.toEqual(DENIAL);
  });
});
