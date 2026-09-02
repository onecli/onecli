import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { initEntitlementForTests } from "../../lib/entitlements";

// claimProvision binds the claimer to the pre-provisioned workspace (step 13a).
// These tests lock in that the binding names the REAL user in both claim
// branches — binding the placeholder (which is deleted, existing-user branch)
// or the wrong id would strand the claimer without workspace access.

const state = vi.hoisted(() => ({
  provision: null as Record<string, unknown> | null,
  existingUser: null as { id: string; name?: string | null } | null,
  existingMembership: null as { userId: string } | null,
  authIdConflict: null as { id: string } | null,
  waUpserts: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => {
  // Recording transaction client. Only workspaceAccess.upsert is asserted; the
  // rest are no-op recorders so the claim transaction runs to completion. The
  // in-tx status re-check reads a pending provision.
  const tx = {
    userProvision: {
      // The CAS replay guard: count 1 = this transaction won the claim.
      updateMany: async () => ({ count: 1 }),
      update: async (a: Record<string, unknown>) => a,
      delete: async (a: Record<string, unknown>) => a,
    },
    organizationMember: {
      delete: async (a: Record<string, unknown>) => a,
      update: async (a: Record<string, unknown>) => a,
    },
    user: { update: async (a: Record<string, unknown>) => a },
    workspace: { update: async (a: Record<string, unknown>) => a },
    workspaceAccess: {
      upsert: async (a: Record<string, unknown>) => {
        state.waUpserts.push(a);
        return a;
      },
    },
    apiKey: { updateMany: async (a: Record<string, unknown>) => a },
  };
  return {
    db: {
      userProvision: {
        findUnique: async () => state.provision,
        update: async (a: Record<string, unknown>) => a,
      },
      // The claim's pre-transfer guard: the pre-minted workspace still exists.
      workspace: { findUnique: async () => ({ id: "ws-1" }) },
      user: {
        findUnique: async () => state.existingUser,
        findFirst: async () => state.authIdConflict,
      },
      organizationMember: {
        findUnique: async () => state.existingMembership,
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock("./user-service", () => ({
  deletePlaceholderUser: async () => {},
}));

import { claimProvision } from "./user-provision-service";

const PENDING_PROVISION = {
  id: "prov-1",
  organizationId: "org-1",
  userId: "placeholder-1",
  workspaceId: "ws-1",
  status: "pending",
  skipOnboarding: true,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  organization: { name: "Acme" },
};

beforeEach(() => {
  state.provision = null;
  state.existingUser = null;
  state.existingMembership = null;
  state.authIdConflict = null;
  state.waUpserts = [];
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("claimProvision → workspace binding (step 13a)", () => {
  it("binds the pre-existing real user, never the placeholder", async () => {
    // The claimer already has an account; ownership is repointed onto it. The
    // placeholder is deleted at the end of this branch, so the binding must
    // name the real user or the workspace becomes unreachable.
    state.provision = PENDING_PROVISION;
    state.existingUser = { id: "real-user-1" };
    state.existingMembership = null;

    const result = await claimProvision(
      "token-1",
      "real-user-1",
      "owner@acme.com",
      "real-sub",
    );

    expect(state.waUpserts).toHaveLength(1);
    expect(state.waUpserts[0]).toMatchObject({
      where: {
        workspaceId_userId: { workspaceId: "ws-1", userId: "real-user-1" },
      },
      create: { workspaceId: "ws-1", userId: "real-user-1", role: "owner" },
      update: { role: "owner" },
    });
    expect(result.organizationId).toBe("org-1");
    expect(result.organizationName).toBe("Acme");
  });

  it("binds the rebound placeholder (now the claimer) for a first-time user", async () => {
    // No prior account: the placeholder is rebound in place to the claimer's
    // identity, so its id now IS the real user — bind that id.
    state.provision = PENDING_PROVISION;
    state.existingUser = null;
    state.authIdConflict = null;

    const result = await claimProvision(
      "token-1",
      "real-user-1",
      "owner@acme.com",
      "real-sub",
    );

    expect(state.waUpserts).toHaveLength(1);
    expect(state.waUpserts[0]).toMatchObject({
      where: {
        workspaceId_userId: { workspaceId: "ws-1", userId: "placeholder-1" },
      },
      create: { workspaceId: "ws-1", userId: "placeholder-1", role: "owner" },
      update: { role: "owner" },
    });
    expect(result.organizationId).toBe("org-1");
    expect(result.organizationName).toBe("Acme");
  });
});
