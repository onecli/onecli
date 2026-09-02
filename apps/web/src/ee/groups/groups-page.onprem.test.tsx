// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The entitled-self-host proof: a LICENSED onprem instance must render Groups,
 * not bounce to /workspaces. The client bundle's CAPS.rbac is false on every
 * self-host — licensed or not — so gating this page on it dark-holed the
 * feature for exactly the deployments that paid for it (the shipped bug this
 * file pins). The page reads the runtime entitlement instead.
 */

// Three pins, all before the module graph loads:
//  • NEXT_PUBLIC_EDITION deleted → parseEdition → onprem → web CAPS.rbac false
//    (frozen at `@/lib/env` module load, hence vi.hoisted).
//  • EDITION deleted → `isEntitled()` reads `EDITION ?? NEXT_PUBLIC_EDITION`
//    first, and apps/web has no hermetic-env setup (#825 wired it into
//    @onecli/api only) — an ambient shell EDITION=cloud would silently force
//    entitled and make every arm below vacuous.
//  • ENTERPRISE_ENABLED deleted → each test owns its own entitlement.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

const state = vi.hoisted(() => ({
  role: "admin",
  roleChecks: 0,
}));

// redirect() never returns in production — a fall-through mock would let the
// page keep executing past a guard and hide the exact bug under test.
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContext: async () => ({
    userId: "u1",
    userEmail: "u1@example.test",
    organizationId: "org-1",
  }),
}));

// requireOrgAdmin delegates to requireRole; the real one reads the API
// package's module-load-frozen CAPS, which the per-test entitlement flips
// below can't reach — drive it from `state` instead.
vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  requireRole: async () => {
    state.roleChecks += 1;
    if (state.role !== "admin" && state.role !== "owner") {
      throw new Error("FORBIDDEN");
    }
  },
}));

// The page's children are "use client" react-query surfaces — out of scope.
vi.mock("./_components/group-list", () => ({
  GroupList: () => <div data-testid="group-list" />,
}));
vi.mock("./_components/role-mapping-list", () => ({
  RoleMappingList: () => <div data-testid="role-mapping-list" />,
}));

import { CAPS } from "@/lib/env";
import GroupsPage from "./groups-page";

beforeEach(() => {
  redirect.mockClear();
  state.role = "admin";
  state.roleChecks = 0;
  vi.stubEnv("ENTERPRISE_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GroupsPage on a licensed self-host", () => {
  it("is running onprem with the client CAPS.rbac off (the premise of this file)", () => {
    // Without this the file passes vacuously if the pin slips and CI's
    // job-wide NEXT_PUBLIC_EDITION=cloud leaks in.
    expect(CAPS.rbac).toBe(false);
  });

  it("renders for an admin — never redirects", async () => {
    // MUTATION-TESTED (the entitlement gate): restore `if (!CAPS.rbac)
    // redirect(...)` and a paying self-host admin is bounced to /workspaces
    // on every visit — Groups sits in the sidebar, licensed and unreachable.
    render(await GroupsPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("group-list")).toBeInTheDocument();
    expect(screen.getByTestId("role-mapping-list")).toBeInTheDocument();
  });

  it("renders for an owner too", async () => {
    state.role = "owner";
    render(await GroupsPage());
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("GroupsPage guards", () => {
  it("redirects a member to workspaces", async () => {
    // MUTATION-TESTED (the role gate): drop `await requireOrgAdmin()` and any
    // member of a licensed org walks into directory management — a page of
    // 403s at best, and the wrong answer about who administers the directory.
    state.role = "member";
    await expect(GroupsPage()).rejects.toThrow(
      "NEXT_REDIRECT:/org/org-1/workspaces",
    );
    expect(redirect).toHaveBeenCalledWith("/org/org-1/workspaces");
  });

  it("keeps an UNLICENSED self-host dark before any role read", async () => {
    // MUTATION-TESTED (the license self-gate): drop `if (!isEntitled())` and
    // a mount that forgets the route wrapper serves the licensed surface to
    // an unlicensed install. Owner role, so only the license gate redirects.
    vi.stubEnv("ENTERPRISE_ENABLED", "");
    state.role = "owner";
    await expect(GroupsPage()).rejects.toThrow(
      "NEXT_REDIRECT:/org/org-1/workspaces",
    );
    expect(state.roleChecks).toBe(0);
  });
});
