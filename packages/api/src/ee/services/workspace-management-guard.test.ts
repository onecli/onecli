import { beforeEach, describe, expect, it, vi } from "vitest";

// Branch-level test of the 403-vs-404 management policy with the two access
// predicates mocked, so each arm is exercised deterministically (the route
// suite only drives managers end-to-end — the FORBIDDEN arm, access without
// manage, is only reachable here).

vi.mock("./authorization-service", () => ({
  canManageWorkspace: vi.fn(),
  canAccessWorkspace: vi.fn(),
}));

import { requireWorkspaceManagement } from "./workspace-management-guard";
import {
  canManageWorkspace,
  canAccessWorkspace,
} from "./authorization-service";
import type { AuthContext } from "../../providers";

const mockManage = vi.mocked(canManageWorkspace);
const mockAccess = vi.mocked(canAccessWorkspace);

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "user-1",
  userEmail: "u@a.com",
  organizationId: "org-1",
  ...over,
});

beforeEach(() => {
  mockManage.mockReset();
  mockAccess.mockReset();
});

describe("requireWorkspaceManagement", () => {
  it("404s a workspace-scoped key reaching outside its own workspace, before any DB check", async () => {
    await expect(
      requireWorkspaceManagement(
        ctx({ scope: "workspace", workspaceId: "proj-a" }),
        "proj-b",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Confinement short-circuits — neither predicate is consulted.
    expect(mockManage).not.toHaveBeenCalled();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it("allows a manager (creator or admin) and never consults access", async () => {
    mockManage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx({ scope: "session" }), "proj-a"),
    ).resolves.toBeUndefined();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it("403s a shared-in member who can access but not manage (the rename-bug fix)", async () => {
    mockManage.mockResolvedValue(false);
    mockAccess.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx({ scope: "session" }), "proj-a"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s a stranger with neither manage nor access — no existence leak", async () => {
    mockManage.mockResolvedValue(false);
    mockAccess.mockResolvedValue(false);
    await expect(
      requireWorkspaceManagement(ctx({ scope: "session" }), "proj-a"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never confines an org key (scope!=='workspace'), gating only on management", async () => {
    mockManage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(
        ctx({ scope: "organization", workspaceId: undefined }),
        "proj-b",
      ),
    ).resolves.toBeUndefined();
    expect(mockManage).toHaveBeenCalledWith("user-1", "proj-b");
  });

  it("lets a workspace key manage its OWN workspace (passes confinement, then gates)", async () => {
    mockManage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(
        ctx({ scope: "workspace", workspaceId: "proj-a" }),
        "proj-a",
      ),
    ).resolves.toBeUndefined();
    expect(mockManage).toHaveBeenCalledWith("user-1", "proj-a");
  });
});
