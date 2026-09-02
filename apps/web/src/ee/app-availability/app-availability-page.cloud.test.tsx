// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud arm of the app-availability-page guards: proves the entitled-self-host
 * fix regressed nothing on cloud, where CAPS.rbac is true at build time and
 * the entitlement is forced on. Same surface as the onprem arm — only the pin
 * differs.
 */

// Pin cloud before the module graph loads; EDITION/ENTERPRISE_ENABLED deleted
// so an ambient shell can't skew `isEntitled()` (cloud force-entitles).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

const state = vi.hoisted(() => ({
  role: "admin",
}));

// redirect() never returns in production — a fall-through mock would let the
// page keep executing past a guard and hide a broken gate.
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

vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  requireRole: async () => {
    if (state.role !== "admin" && state.role !== "owner") {
      throw new Error("FORBIDDEN");
    }
  },
}));

vi.mock("./_components/app-availability-editor", () => ({
  AppAvailabilityEditor: () => <div data-testid="availability-editor" />,
}));

import { CAPS } from "@/lib/env";
import AppAvailabilityPage from "./app-availability-page";

beforeEach(() => {
  redirect.mockClear();
  state.role = "admin";
});

describe("AppAvailabilityPage on cloud", () => {
  it("is running the rbac build (the premise of this file)", () => {
    expect(CAPS.rbac).toBe(true);
  });

  it("renders for an admin with no ENTERPRISE_ENABLED set", async () => {
    // Cloud is always entitled — the license self-gate must never fire there.
    render(await AppAvailabilityPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("availability-editor")).toBeInTheDocument();
  });

  it("still redirects a member to workspaces", async () => {
    state.role = "member";
    await expect(AppAvailabilityPage()).rejects.toThrow(
      "NEXT_REDIRECT:/org/org-1/workspaces",
    );
  });
});
