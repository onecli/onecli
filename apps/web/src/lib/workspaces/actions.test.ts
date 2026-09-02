import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getActiveOrganizationId` backs the sidebar chrome (org switcher, account
 * menu), which mounts on EVERY dashboard page — including bare /org while its
 * redirect streams, and /account, whose URLs carry no org context so the
 * proxy sets no path-derived headers. The law pinned here: with no header
 * context the action answers the cookie-validated default org (or null) and
 * NEVER throws — a throw becomes a 500 on the server-action POST, which was
 * the broken blank-dashboard first-open frame on a fresh install.
 */

const state = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  resolvedOrgId: "org-from-context",
  defaultOrgId: "org-default" as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => state.headers.get(name) ?? null,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("unexpected redirect");
  },
}));

// Mirrors the real resolver's contract: without header context it THROWS —
// the fix must therefore never reach it off org-scoped URLs.
vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContext: async () => {
    if (
      !state.headers.get("x-organization-id") &&
      !state.headers.get("x-workspace-id")
    ) {
      throw new Error("X-Organization-Id header is required");
    }
    return {
      userId: "u1",
      userEmail: "u@example.test",
      organizationId: state.resolvedOrgId,
    };
  },
}));

vi.mock("@/lib/auth/default-org", () => ({
  getUserDefaultOrgId: async () => state.defaultOrgId,
}));

// The rest of the module graph is irrelevant to this action — stub the
// server-only imports so the "use server" module loads in vitest.
vi.mock("@/lib/auth/server", () => ({ getServerSession: async () => null }));
vi.mock("@onecli/db", () => ({ db: {} }));
vi.mock("@onecli/api/services/audit-service", () => ({
  withAudit: async () => {},
  AUDIT_ACTIONS: {},
  AUDIT_SERVICES: {},
}));
vi.mock("@onecli/api/services/organization-service", () => ({
  activeMembershipWhere: {},
  workspaceNameForOwner: () => "x",
}));
vi.mock("@onecli/api/ee/sso/sso-enforcement", () => ({
  enforceSsoSession: async () => null,
}));
vi.mock("@/lib/auth/set-active-scope", () => ({
  setDefaultOrgCookie: async () => {},
}));
vi.mock("@onecli/api/ee/services/workspace-service", () => ({
  ensureUserDefaultOrgAndWorkspace: async () => {},
  listWorkspaces: async () => [],
  createWorkspace: async () => ({}),
}));
vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  getUserRole: async () => null,
  canAccessWorkspace: async () => false,
}));
vi.mock("@onecli/api/ee/services/quota-service", () => ({
  getWorkspaceQuota: async () => ({}),
  assertCanCreateWorkspace: async () => {},
}));
vi.mock("@/lib/safe-action", () => ({
  safeAction: async (fn: () => Promise<unknown>) => fn(),
}));

import { getActiveOrganizationId } from "./actions";

beforeEach(() => {
  state.headers.clear();
  state.resolvedOrgId = "org-from-context";
  state.defaultOrgId = "org-default";
});

describe("getActiveOrganizationId", () => {
  it("resolves through the org header on org-scoped URLs", async () => {
    state.headers.set("x-organization-id", "org-1");
    await expect(getActiveOrganizationId()).resolves.toBe("org-from-context");
  });

  it("resolves through the workspace header on /w/ URLs", async () => {
    state.headers.set("x-workspace-id", "ws-1");
    await expect(getActiveOrganizationId()).resolves.toBe("org-from-context");
  });

  it("answers the cookie-validated default — never throws — with no header context", async () => {
    await expect(getActiveOrganizationId()).resolves.toBe("org-default");
  });

  it("answers null when there is no header context and no default org", async () => {
    state.defaultOrgId = null;
    await expect(getActiveOrganizationId()).resolves.toBeNull();
  });
});
