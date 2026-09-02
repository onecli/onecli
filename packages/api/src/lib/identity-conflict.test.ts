import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auditRows: [] as Record<string, unknown>[],
  ssoConnection: null as {
    id: string;
    organizationId: string;
    cognitoProviderName: string;
  } | null,
  verifiedDomain: false,
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: {
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.auditRows.push(data);
        return data;
      },
    },
    organizationSsoConnection: {
      findFirst: async () => state.ssoConnection,
    },
    organizationDomain: {
      findFirst: async () => (state.verifiedDomain ? { id: "dom-1" } : null),
    },
  },
}));

import { resolveIdentityConflict } from "./identity-conflict";
import { initEntitlementForTests } from "./entitlements";

const existing = {
  id: "user-1",
  email: "guy@acme.com",
  externalAuthId: "old-sub",
};

beforeEach(() => {
  state.auditRows = [];
  state.ssoConnection = null;
  state.verifiedDomain = false;
  // The SSO-vouch arms exercise licensed trust behavior; the hermetic env is
  // unlicensed by default and sso-trust's gate would null the vouch. The
  // unlicensed arm of that gate is pinned in sso-trust.test.ts.
  initEntitlementForTests(true);
});

afterEach(() => initEntitlementForTests(null));

describe("resolveIdentityConflict", () => {
  it("links a Google-federated session even without a verified-email claim", async () => {
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        federatedProvider: "Google",
      }),
    ).resolves.toBe("link");
    expect(state.auditRows[0]).toMatchObject({
      service: "auth",
      status: "success",
    });
  });

  it("links a native session whose email was verified (email-OTP)", async () => {
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: true,
        federatedProvider: null,
      }),
    ).resolves.toBe("link");
  });

  it("rejects a native session without a verified email", async () => {
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: false,
        federatedProvider: null,
      }),
    ).resolves.toBe("reject");
    expect(state.auditRows[0]).toMatchObject({
      service: "auth",
      status: "failure",
    });
  });

  it("rejects a session with no identity metadata at all", async () => {
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
      }),
    ).resolves.toBe("reject");
  });

  it("links an enterprise-SSO session whose org verified the email's domain", async () => {
    state.ssoConnection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: "org-a1b2c3d4e5f6a1b2c3d4e5f6",
    };
    state.verifiedDomain = true;
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: false,
        federatedProvider: "org-a1b2c3d4e5f6a1b2c3d4e5f6",
        identityProviders: ["org-a1b2c3d4e5f6a1b2c3d4e5f6"],
      }),
    ).resolves.toBe("link");
  });

  it("finds the SSO provider anywhere in identityProviders (multi-linked token)", async () => {
    state.ssoConnection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: "org-a1b2c3d4e5f6a1b2c3d4e5f6",
    };
    state.verifiedDomain = true;
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: false,
        // identities[0] is NOT the SSO provider — the arm must scan the array
        federatedProvider: "SomethingElse",
        identityProviders: ["SomethingElse", "org-a1b2c3d4e5f6a1b2c3d4e5f6"],
      }),
    ).resolves.toBe("link");
  });

  it("rejects an SSO-shaped provider without a verified org domain", async () => {
    state.ssoConnection = {
      id: "conn-1",
      organizationId: "org-1",
      cognitoProviderName: "org-a1b2c3d4e5f6a1b2c3d4e5f6",
    };
    state.verifiedDomain = false;
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: false,
        federatedProvider: "org-a1b2c3d4e5f6a1b2c3d4e5f6",
        identityProviders: ["org-a1b2c3d4e5f6a1b2c3d4e5f6"],
      }),
    ).resolves.toBe("reject");
  });

  it("rejects an unknown federated provider with no connection row", async () => {
    await expect(
      resolveIdentityConflict(existing, {
        id: "new-sub",
        email: "guy@acme.com",
        emailVerified: false,
        federatedProvider: "org-a1b2c3d4e5f6",
        identityProviders: ["org-a1b2c3d4e5f6"],
      }),
    ).resolves.toBe("reject");
  });

  it("links a verified session onto a provision-placeholder identity", async () => {
    await expect(
      resolveIdentityConflict(
        { ...existing, externalAuthId: "provision-abc123" },
        {
          id: "new-sub",
          email: "guy@acme.com",
          emailVerified: true,
        },
      ),
    ).resolves.toBe("link");
  });

  it("records forensics metadata on both outcomes", async () => {
    await resolveIdentityConflict(existing, {
      id: "new-sub",
      email: "guy@acme.com",
      federatedProvider: "Google",
    });
    await resolveIdentityConflict(existing, {
      id: "evil-sub",
      email: "guy@acme.com",
    });

    expect(state.auditRows).toHaveLength(2);
    expect(state.auditRows[0]).toMatchObject({
      userId: "user-1",
      userEmail: "guy@acme.com",
      action: "update",
      metadata: {
        decision: "link",
        federatedProvider: "Google",
        sessionSub: "new-sub",
        previousExternalAuthId: "old-sub",
      },
    });
    expect(state.auditRows[1]).toMatchObject({
      status: "failure",
      metadata: {
        decision: "reject",
        sessionSub: "evil-sub",
        previousExternalAuthId: "old-sub",
      },
    });
  });
});
