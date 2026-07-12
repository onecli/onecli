import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// canAccessProjectAsUser only enforces under RBAC — pin the cloud edition.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  bindingRow: null as { id: string } | null,
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: { findUnique: async () => null },
    project: { findFirst: async () => null, findUnique: async () => null },
    projectAccess: { findFirst: async () => state.bindingRow },
  },
}));

import { canAccessProjectAsUser } from "./resolve";
import { initRoleResolver } from "../../providers";
import type { OrgRole } from "../../providers";

const PROJECT = {
  id: "proj-1",
  organizationId: "org-1",
};

let role: OrgRole | null = null;

beforeEach(() => {
  role = null;
  state.bindingRow = null;
  initRoleResolver({ getUserRole: async () => role });
});

afterEach(() => {
  initRoleResolver({ getUserRole: async () => null });
});

// Usage flipped to bindings-only in step 13b: an ACTIVE member reaches a project
// iff they are an org admin/owner OR hold a ProjectAccess binding. The creator
// arm is gone, and a binding never rescues a non-member/suspended user — the
// binding check lives *inside* the active-member gate (the suspension invariant),
// so the resolver reading suspended members as null (no role) is what closes it.
describe("canAccessProjectAsUser (cloud, bindings-only)", () => {
  it("admins access any project in their org", async () => {
    role = "admin";
    await expect(canAccessProjectAsUser("someone-else", PROJECT)).resolves.toBe(
      true,
    );
  });

  it("an active member shared in via a ProjectAccess binding gets access", async () => {
    role = "member";
    state.bindingRow = { id: "binding-1" };
    await expect(canAccessProjectAsUser("someone-else", PROJECT)).resolves.toBe(
      true,
    );
  });

  it("an active member with no binding is denied", async () => {
    role = "member";
    state.bindingRow = null;
    await expect(canAccessProjectAsUser("someone-else", PROJECT)).resolves.toBe(
      false,
    );
  });

  it("denies the creator once their binding is gone (13b: no creator arm)", async () => {
    // A creator is just a member now; with no binding they don't get in.
    role = "member";
    state.bindingRow = null;
    await expect(canAccessProjectAsUser("creator-1", PROJECT)).resolves.toBe(
      false,
    );
  });

  it("a membership-less creator is denied (13b closes the creator door)", async () => {
    // Previously a creator with no membership kept access; bindings-only closes
    // it — a binding is only ever consulted for an active member.
    role = null;
    state.bindingRow = null;
    await expect(canAccessProjectAsUser("creator-1", PROJECT)).resolves.toBe(
      false,
    );
  });

  it("a binding does NOT rescue a suspended/non-member (no role)", async () => {
    // No role = non-member or suspended; the stray binding is never consulted
    // because we deny before the active-member binding check.
    role = null;
    state.bindingRow = { id: "binding-1" };
    await expect(canAccessProjectAsUser("someone-else", PROJECT)).resolves.toBe(
      false,
    );
  });
});
