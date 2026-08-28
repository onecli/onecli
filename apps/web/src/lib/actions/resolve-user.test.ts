import { beforeEach, describe, expect, it, vi } from "vitest";

// Edition-neutral behavior under test; pin cloud so the module graph matches
// the deployed shape (the ee seams below are mocked either way).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  memberships: [] as { organizationId: string }[],
  defaultWorkspace: null as { id: string; organizationId: string } | null,
  headers: new Map<string, string>(),
}));

// resolve-user.ts eagerly runs ensureEditionDefaults() through this import.
vi.mock("@/lib/init/server", () => ({}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => ({
    id: "ext-1",
    email: "u@example.test",
    name: "U",
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => state.headers.get(name) ?? null,
  }),
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => ({
        id: "u1",
        email: "u@example.test",
        organizationMemberships: state.memberships,
      }),
    },
    workspace: { findFirst: async () => null },
  },
}));

vi.mock("@onecli/api/services/organization-service", () => ({
  activeMembershipWhere: {},
  findUserDefaultWorkspace: async () => state.defaultWorkspace,
  ensureUserOrganization: async () => {
    throw new Error("bootstrap must not run for an existing user");
  },
}));

vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  canManageAllWorkspaces: () => false,
  getUserRole: async () => null,
  hasWorkspaceAccessBinding: async () => false,
  requireRole: async () => {},
}));

vi.mock("@onecli/api/lib/identity-conflict", () => ({
  IDENTITY_CONFLICT_ERROR: "identity-conflict",
  resolveIdentityConflict: async () => "reject",
}));

vi.mock("@onecli/api/ee/sso/jit-service", () => ({
  ensureSsoJitMembership: async () => {},
}));

vi.mock("@onecli/api/ee/sso/sso-enforcement", () => ({
  enforceSsoSession: async () => null,
}));

import { resolveOrgContext } from "./resolve-user";

beforeEach(() => {
  state.memberships = [
    { organizationId: "org-oldest" },
    { organizationId: "org-newer" },
  ];
  state.defaultWorkspace = null;
  state.headers = new Map();
});

describe("resolveOrgContext fallback", () => {
  it("a member with NO created workspace resolves to the oldest membership org", async () => {
    // MUTATION-TESTED (the membership fallback): revert the last-resort arm
    // and every directory-provisioned member, deleted-default-workspace member,
    // and multi-org member without a created workspace in their oldest org
    // throws here — the exact 500 that stranded /onboarding on a spinner.
    await expect(
      resolveOrgContext({ fallbackToDefault: true }),
    ).resolves.toMatchObject({ organizationId: "org-oldest", userId: "u1" });
  });

  it("a created workspace still wins over the membership fallback", async () => {
    state.defaultWorkspace = { id: "p1", organizationId: "org-newer" };
    await expect(
      resolveOrgContext({ fallbackToDefault: true }),
    ).resolves.toMatchObject({ organizationId: "org-newer" });
  });

  it("without fallbackToDefault a headerless call still refuses", async () => {
    await expect(resolveOrgContext()).rejects.toThrow(
      "X-Organization-Id header is required",
    );
  });

  it("the x-organization-id header keeps precedence over every fallback", async () => {
    state.headers.set("x-organization-id", "org-newer");
    state.defaultWorkspace = { id: "p1", organizationId: "org-oldest" };
    await expect(
      resolveOrgContext({ fallbackToDefault: true }),
    ).resolves.toMatchObject({ organizationId: "org-newer" });
  });

  it("a header naming a foreign org is ignored, not honored", async () => {
    state.headers.set("x-organization-id", "org-foreign");
    await expect(
      resolveOrgContext({ fallbackToDefault: true }),
    ).resolves.toMatchObject({ organizationId: "org-oldest" });
  });
});
