import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where "go to this org" and "go home" end. Both answer the FINAL page (an
 * agent), so callers navigate once. The fence is `resolveOrgLanding`'s (a
 * non-member gets null there); pinned here is what each answer becomes,
 * including the negative control: no landing for a foreign org falls back
 * to that org's workspaces URL, whose layout turns the caller away, never
 * to anything that names one of its workspaces.
 */

const mocks = vi.hoisted(() => ({
  resolveOrgLanding: vi.fn(),
  getUserDefaultOrgId: vi.fn(),
}));
vi.mock("./org-landing", () => ({
  resolveOrgLanding: mocks.resolveOrgLanding,
}));
vi.mock("@/lib/auth/default-org", () => ({
  getUserDefaultOrgId: mocks.getUserDefaultOrgId,
}));

const { resolveDefaultHome, resolveOrgHome } = await import("./home-landing");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOrgLanding.mockResolvedValue("/w/ws1/agents/ag1/chat");
  mocks.getUserDefaultOrgId.mockResolvedValue("org1");
});

describe("resolveOrgHome", () => {
  it("is the org's first agent, resolved for that org", async () => {
    await expect(resolveOrgHome("org1")).resolves.toBe(
      "/w/ws1/agents/ag1/chat",
    );
    expect(mocks.resolveOrgLanding).toHaveBeenCalledWith("org1");
  });

  it("is the org's workspaces page when there is no landing (empty, or not a member)", async () => {
    mocks.resolveOrgLanding.mockResolvedValue(null);
    await expect(resolveOrgHome("org_foreign")).resolves.toBe(
      "/org/org_foreign/workspaces",
    );
  });
});

describe("resolveDefaultHome", () => {
  it("is the default org's first agent", async () => {
    await expect(resolveDefaultHome()).resolves.toBe("/w/ws1/agents/ag1/chat");
    expect(mocks.resolveOrgLanding).toHaveBeenCalledWith("org1");
  });

  it("is null, reading nothing else, when the user belongs to no org", async () => {
    mocks.getUserDefaultOrgId.mockResolvedValue(null);
    await expect(resolveDefaultHome()).resolves.toBeNull();
    expect(mocks.resolveOrgLanding).not.toHaveBeenCalled();
  });
});
