import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// canAccessWorkspaceAsUser only enforces under RBAC — pin the cloud edition.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  bindingRow: null as { id: string } | null,
  role: null as import("../../providers").OrgRole | null,
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: { findUnique: async () => null },
    workspace: { findFirst: async () => null, findUnique: async () => null },
    workspaceAccess: { findFirst: async () => state.bindingRow },
    // The licensed checker reads roles through getUserRole's membership
    // query; `state.role = null` models a non-member/suspended user.
    organizationMember: {
      findUnique: async () =>
        state.role === null ? null : { role: state.role, status: "active" },
    },
  },
}));

import { canAccessWorkspaceAsUser } from "./resolve";
import { initWorkspaceAccessChecker } from "../../providers";
// Tests may cross the license boundary: inject the REAL licensed checker so
// this suite keeps proving the full path (shared predicate → seam → licensed
// admin-or-binding resolution → db).
import { eeWorkspaceAccessChecker } from "../../ee/services/authorization-service";

const WORKSPACE = {
  id: "proj-1",
  organizationId: "org-1",
};

beforeEach(() => {
  state.role = null;
  state.bindingRow = null;
  initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
});

afterEach(() => {
  initWorkspaceAccessChecker(null);
});

// Usage flipped to bindings-only in step 13b: an ACTIVE member reaches a workspace
// iff they are an org admin/owner OR hold a WorkspaceAccess binding. The creator
// arm is gone, and a binding never rescues a non-member/suspended user — the
// binding check lives *inside* the active-member gate (the suspension invariant),
// so the resolver reading suspended members as null (no role) is what closes it.
describe("canAccessWorkspaceAsUser (cloud, bindings-only)", () => {
  it("admins access any workspace in their org", async () => {
    state.role = "admin";
    await expect(
      canAccessWorkspaceAsUser("someone-else", WORKSPACE),
    ).resolves.toBe(true);
  });

  it("an active member shared in via a WorkspaceAccess binding gets access", async () => {
    state.role = "member";
    state.bindingRow = { id: "binding-1" };
    await expect(
      canAccessWorkspaceAsUser("someone-else", WORKSPACE),
    ).resolves.toBe(true);
  });

  it("an active member with no binding is denied", async () => {
    state.role = "member";
    state.bindingRow = null;
    await expect(
      canAccessWorkspaceAsUser("someone-else", WORKSPACE),
    ).resolves.toBe(false);
  });

  it("denies the creator once their binding is gone (13b: no creator arm)", async () => {
    // A creator is just a member now; with no binding they don't get in.
    state.role = "member";
    state.bindingRow = null;
    await expect(
      canAccessWorkspaceAsUser("creator-1", WORKSPACE),
    ).resolves.toBe(false);
  });

  it("a membership-less creator is denied (13b closes the creator door)", async () => {
    // Previously a creator with no membership kept access; bindings-only closes
    // it — a binding is only ever consulted for an active member.
    state.role = null;
    state.bindingRow = null;
    await expect(
      canAccessWorkspaceAsUser("creator-1", WORKSPACE),
    ).resolves.toBe(false);
  });

  it("a binding does NOT rescue a suspended/non-member (no role)", async () => {
    // No role = non-member or suspended; the stray binding is never consulted
    // because we deny before the active-member binding check.
    state.role = null;
    state.bindingRow = { id: "binding-1" };
    await expect(
      canAccessWorkspaceAsUser("someone-else", WORKSPACE),
    ).resolves.toBe(false);
  });
});
