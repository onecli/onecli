import { beforeEach, describe, expect, it, vi } from "vitest";

// ── resolveSettingsModal: who may open which page, and what the picker shows ─
//
// The resolver is the modal's only server gate, so each rule here is pinned
// with its negative control: a non-member gets no modal, a member gets no
// admin page, and the workspace picker lists only the workspaces the viewer
// may open (never every workspace of the org by name).

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findUser: vi.fn(),
  findMembership: vi.fn(),
  findWorkspaces: vi.fn(),
  userIsOrgAdmin: vi.fn(),
  canManageWorkspace: vi.fn(),
  getUserRole: vi.fn(),
  visibleWorkspacesWhere: vi.fn(),
  getRunnerAvailability: vi.fn(),
  requireAccessibleWorkspace: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: { findUnique: mocks.findUser },
    organizationMember: { findFirst: mocks.findMembership },
    workspace: { findMany: mocks.findWorkspaces },
  },
}));
vi.mock("@onecli/api/services/workspace-access-check", () => ({
  userIsOrgAdmin: mocks.userIsOrgAdmin,
}));
vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  canManageWorkspace: mocks.canManageWorkspace,
  getUserRole: mocks.getUserRole,
  visibleWorkspacesWhere: mocks.visibleWorkspacesWhere,
}));
vi.mock("@onecli/api/services/runner-service", () => ({
  getRunnerAvailability: mocks.getRunnerAvailability,
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@/lib/workspaces/workspace-access", () => ({
  requireAccessibleWorkspace: mocks.requireAccessibleWorkspace,
}));

const { resolveSettingsModal } = await import("./resolve");

const BOUND = { organizationId: "org_1", OR: ["bindings"] };
const params = (settings: string) => Promise.resolve({ settings });
const wsScope = { organizationId: "org_1", workspaceId: "ws_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ id: "auth_1" });
  mocks.findUser.mockResolvedValue({ id: "user_1" });
  mocks.findMembership.mockResolvedValue({ userId: "user_1" });
  mocks.userIsOrgAdmin.mockResolvedValue(false);
  mocks.canManageWorkspace.mockResolvedValue(false);
  mocks.getUserRole.mockResolvedValue("member");
  mocks.visibleWorkspacesWhere.mockReturnValue(BOUND);
  mocks.getRunnerAvailability.mockResolvedValue({ registered: true });
  mocks.requireAccessibleWorkspace.mockResolvedValue({ id: "ws_1" });
  mocks.findWorkspaces.mockResolvedValue([
    { id: "ws_1", name: "Mine" },
    { id: "ws_2", name: "Shared with me" },
  ]);
});

describe("resolveSettingsModal", () => {
  it("opens nothing for an unknown page or a viewer outside the org", async () => {
    await expect(
      resolveSettingsModal(wsScope, params("team")),
    ).resolves.toBeNull();
    mocks.findMembership.mockResolvedValue(null);
    await expect(
      resolveSettingsModal(wsScope, params("apps")),
    ).resolves.toBeNull();
  });

  it("opens nothing on an admin page for a member, whatever the link says", async () => {
    await expect(
      resolveSettingsModal(wsScope, params("members")),
    ).resolves.toBeNull();
    mocks.userIsOrgAdmin.mockResolvedValue(true);
    await expect(
      resolveSettingsModal(wsScope, params("members")),
    ).resolves.toMatchObject({ page: "members" });
  });

  it("lists only the workspaces the viewer may open in the picker", async () => {
    const request = await resolveSettingsModal(wsScope, params("apps"));
    expect(mocks.visibleWorkspacesWhere).toHaveBeenCalledWith(
      "user_1",
      "org_1",
      "member",
    );
    // The fence is the query's own `where`, never a filter after the read.
    expect(mocks.findWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({ where: BOUND }),
    );
    expect(request?.workspaces.map((w) => w.id)).toEqual(["ws_1", "ws_2"]);
  });

  it("hides the picker when the viewer can open only one workspace", async () => {
    mocks.findWorkspaces.mockResolvedValue([{ id: "ws_1", name: "Mine" }]);
    const request = await resolveSettingsModal(wsScope, params("apps"));
    expect(request?.workspaces).toEqual([]);
  });

  it("reads no workspaces for a page outside the Workspace section", async () => {
    const request = await resolveSettingsModal(wsScope, params("profile"));
    expect(request?.page).toBe("profile");
    expect(request?.workspaces).toEqual([]);
    expect(mocks.findWorkspaces).not.toHaveBeenCalled();
  });
});
