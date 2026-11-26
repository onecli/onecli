import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every `/account` address: forwards into Settings > Profile over the
 * viewer's org, in one hop; renders the profile as a page for a viewer with
 * no org, who has no landing to open the modal over. Before this page, that
 * viewer was bounced to org creation with no way to rename, change their
 * password or delete their account.
 */

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  getServerSession: vi.fn(),
  getUserDefaultOrgId: vi.fn(),
  resolveOrgLanding: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@/lib/auth/default-org", () => ({
  getUserDefaultOrgId: mocks.getUserDefaultOrgId,
}));
vi.mock("@/lib/dashboard/org-landing", () => ({
  resolveOrgLanding: mocks.resolveOrgLanding,
}));
vi.mock("@/lib/workspaces/workspace-landing", () => ({
  resolveWorkspaceLanding: vi.fn(),
}));
vi.mock("@/lib/settings-modal/profile-body", () => ({
  ProfileBody: () => null,
}));

const { default: AccountPage } = await import("./account-page");
const { ProfileBody } = await import("@/lib/settings-modal/profile-body");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ id: "user_1" });
  mocks.resolveOrgLanding.mockResolvedValue("/w/ws_1/agents/ag_1");
});

describe("AccountPage", () => {
  it("forwards a viewer with an org into Settings > Profile over its landing", async () => {
    mocks.getUserDefaultOrgId.mockResolvedValue("org_1");
    await expect(AccountPage()).rejects.toThrow(
      "NEXT_REDIRECT:/w/ws_1/agents/ag_1?settings=profile",
    );
    expect(mocks.resolveOrgLanding).toHaveBeenCalledWith("org_1");
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("renders the profile for a viewer with no org, with no redirect", async () => {
    mocks.getUserDefaultOrgId.mockResolvedValue(null);
    const page = await AccountPage();
    expect(page.type).toBe(ProfileBody);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in, before reading any org", async () => {
    mocks.getServerSession.mockResolvedValue(null);
    await expect(AccountPage()).rejects.toThrow("NEXT_REDIRECT:/auth/login");
    expect(mocks.getUserDefaultOrgId).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("is every page under /account", async () => {
    for (const route of [
      "@/app/(dashboard)/account/page",
      "@/app/(dashboard)/account/preferences/page",
      "@/app/(dashboard)/account/ssh-keys/page",
      "@/app/(dashboard)/account/audit-logs/page",
    ]) {
      expect((await import(route)).default, route).toBe(AccountPage);
    }
  });
});
