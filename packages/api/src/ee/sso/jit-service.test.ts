import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { PrismaClientKnownRequestError } = vi.hoisted(() => {
  class HoistedPrismaError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { PrismaClientKnownRequestError: HoistedPrismaError };
});

const state = vi.hoisted(() => ({
  connection: null as {
    id: string;
    organizationId: string;
    cognitoProviderName: string;
  } | null,
  verifiedDomain: false,
  membership: null as { userId: string } | null,
  org: null as { jitEnabled: boolean } | null,
  memberCreates: [] as Record<string, unknown>[],
  workspaceCreates: [] as Record<string, unknown>[],
  activeFlips: [] as Record<string, unknown>[],
  activeFlipCount: 1,
  auditRows: [] as Record<string, unknown>[],
  transactions: 0,
  transactionThrowsP2002: false,
  orgQueryThrows: false,
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null, PrismaClientKnownRequestError },
  db: {
    organizationSsoConnection: {
      findFirst: async () => state.connection,
      updateMany: async (args: Record<string, unknown>) => {
        state.activeFlips.push(args);
        return { count: state.activeFlipCount };
      },
    },
    organizationDomain: {
      findFirst: async () => (state.verifiedDomain ? { id: "dom-1" } : null),
    },
    organizationMember: {
      findUnique: async () => state.membership,
      create: (args: Record<string, unknown>) => {
        state.memberCreates.push(args);
        return args;
      },
    },
    // JIT membership re-resolves group→role mappings on the entitled (cloud)
    // lane; empty = nobody is in a mapped group, so reconcile is a no-op.
    groupMember: { findMany: async () => [] },
    organization: {
      findUnique: async () => {
        if (state.orgQueryThrows) throw new Error("db down");
        return state.org;
      },
    },
    workspace: {
      create: (args: Record<string, unknown>) => {
        state.workspaceCreates.push(args);
        return args;
      },
    },
    $transaction: async (ops: unknown[]) => {
      if (state.transactionThrowsP2002) {
        throw new PrismaClientKnownRequestError("duplicate", "P2002");
      }
      state.transactions += 1;
      return ops;
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.auditRows.push(data);
        return data;
      },
    },
  },
}));

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCacheForOrg: () => {},
}));

import { ensureSsoJitMembership } from "./jit-service";
import { initEntitlementForTests } from "../../lib/entitlements";

afterEach(() => initEntitlementForTests(null));

const PROVIDER = "org-0f9b2c4d6e8a0b1c2d3e4f5a";
const session = {
  id: "sso-sub",
  email: "guy@acme.com",
  identityProviders: [PROVIDER],
};
const user = { id: "user-1", email: "guy@acme.com", name: "Guy" };

const liveTrust = () => {
  state.connection = {
    id: "conn-1",
    organizationId: "org-1",
    cognitoProviderName: PROVIDER,
  };
  state.verifiedDomain = true;
};

beforeEach(() => {
  // JIT membership is licensed behavior reached through sso-trust's vouch;
  // the hermetic env is unlicensed by default (gate pinned in sso-trust.test.ts).
  initEntitlementForTests(true);
  state.connection = null;
  state.verifiedDomain = false;
  state.membership = null;
  state.org = null;
  state.memberCreates = [];
  state.workspaceCreates = [];
  state.activeFlips = [];
  state.activeFlipCount = 1;
  state.auditRows = [];
  state.transactions = 0;
  state.transactionThrowsP2002 = false;
  state.orgQueryThrows = false;
});

describe("ensureSsoJitMembership", () => {
  it("joins a new user as member with an owner-named workspace, audited", async () => {
    liveTrust();
    state.org = { jitEnabled: true };

    await ensureSsoJitMembership(session, user);

    expect(state.memberCreates[0]).toMatchObject({
      data: {
        organizationId: "org-1",
        userId: "user-1",
        userEmail: "guy@acme.com",
        role: "member",
      },
    });
    // The JIT-provisioned workspace is named after the joining user.
    expect(state.workspaceCreates[0]).toMatchObject({
      data: { organizationId: "org-1", name: "Guy" },
    });
    expect(state.transactions).toBe(1);
    const memberAudit = state.auditRows.find((r) => r.service === "member");
    expect(memberAudit).toMatchObject({
      source: "sso-jit",
      action: "create",
      organizationId: "org-1",
    });
  });

  it("marks the connection active and audits only when a row actually flips", async () => {
    liveTrust();
    state.org = { jitEnabled: true };
    state.activeFlipCount = 1;

    await ensureSsoJitMembership(session, user);
    expect(state.activeFlips[0]).toMatchObject({
      where: { id: "conn-1", organizationId: "org-1", status: "pending" },
      data: { status: "active" },
    });
    expect(
      state.auditRows.filter((r) => r.service === "sso-connection"),
    ).toHaveLength(1);

    // Second login: updateMany matches nothing — no second audit row.
    state.activeFlipCount = 0;
    state.membership = { userId: "user-1" };
    await ensureSsoJitMembership(session, user);
    expect(
      state.auditRows.filter((r) => r.service === "sso-connection"),
    ).toHaveLength(1);
  });

  it("no-ops for existing members (but still flips pending connections)", async () => {
    liveTrust();
    state.membership = { userId: "user-1" };

    await ensureSsoJitMembership(session, user);
    expect(state.memberCreates).toHaveLength(0);
    expect(state.transactions).toBe(0);
    expect(state.activeFlips).toHaveLength(1);
  });

  it("no-ops when the org disabled JIT", async () => {
    liveTrust();
    state.org = { jitEnabled: false };

    await ensureSsoJitMembership(session, user);
    expect(state.memberCreates).toHaveLength(0);
  });

  it("no-ops for non-SSO sessions without touching the DB", async () => {
    await ensureSsoJitMembership(
      { id: "sub", email: "guy@acme.com", identityProviders: ["Google"] },
      user,
    );
    await ensureSsoJitMembership({ id: "sub", email: "guy@acme.com" }, user);
    expect(state.activeFlips).toHaveLength(0);
    expect(state.memberCreates).toHaveLength(0);
  });

  it("treats a concurrent-create unique violation as success", async () => {
    liveTrust();
    state.org = { jitEnabled: true };
    state.transactionThrowsP2002 = true;
    await expect(
      ensureSsoJitMembership(session, user),
    ).resolves.toBeUndefined();
  });

  it("never throws — internal errors are swallowed and logged", async () => {
    liveTrust();
    state.orgQueryThrows = true;
    await expect(
      ensureSsoJitMembership(session, user),
    ).resolves.toBeUndefined();
  });
});
