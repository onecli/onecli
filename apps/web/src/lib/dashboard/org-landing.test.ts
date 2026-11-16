import { beforeEach, describe, expect, it, vi } from "vitest";

// ── resolveOrgLanding: where /org/<id> lands ──────────────────────────────
//
// One hop to the first visible workspace's first agent. Pinned because the
// settings-route redirects append `?settings=<page>` to this URL: a landing
// on the workspace front door (`/w/<id>`) would redirect again and drop it.

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findUser: vi.fn(),
  findWorkspace: vi.fn(),
  findAgent: vi.fn(),
  getUserRole: vi.fn(),
  visibleWorkspacesWhere: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: { findUnique: mocks.findUser },
    workspace: { findFirst: mocks.findWorkspace },
    agent: { findFirst: mocks.findAgent },
  },
}));
vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  getUserRole: mocks.getUserRole,
  visibleWorkspacesWhere: mocks.visibleWorkspacesWhere,
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));

import { workspaceLandingPath } from "@/lib/agents/agent-order";
import { resolveOrgLanding } from "./org-landing";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ id: "auth_1" });
  mocks.findUser.mockResolvedValue({ id: "user_1" });
  mocks.getUserRole.mockResolvedValue("admin");
  mocks.visibleWorkspacesWhere.mockReturnValue({ organizationId: "org_1" });
  mocks.findWorkspace.mockResolvedValue({ id: "ws_1" });
  mocks.findAgent.mockResolvedValue({ id: "ag_1", kind: "HOSTED" });
});

describe("resolveOrgLanding", () => {
  it("lands on the first visible workspace's first agent in one hop", async () => {
    await expect(resolveOrgLanding("org_1")).resolves.toBe(
      workspaceLandingPath("ws_1", { id: "ag_1", kind: "HOSTED" }),
    );
    expect(mocks.visibleWorkspacesWhere).toHaveBeenCalledWith(
      "user_1",
      "org_1",
      "admin",
    );
    expect(mocks.findAgent).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1" } }),
    );
  });

  it("lands on the agents index when that workspace has no agent", async () => {
    mocks.findAgent.mockResolvedValue(null);
    await expect(resolveOrgLanding("org_1")).resolves.toBe(
      workspaceLandingPath("ws_1", null),
    );
  });

  it("is null for a viewer who is not an active member, before any workspace is read", async () => {
    // The negative control: a foreign (or suspended) org id must never come
    // back as one of its workspaces' agent URLs.
    mocks.getUserRole.mockResolvedValue(null);
    await expect(resolveOrgLanding("org_foreign")).resolves.toBeNull();
    expect(mocks.findWorkspace).not.toHaveBeenCalled();
    expect(mocks.findAgent).not.toHaveBeenCalled();
  });

  it("is null when the viewer has no workspace to land in", async () => {
    mocks.findWorkspace.mockResolvedValue(null);
    await expect(resolveOrgLanding("org_1")).resolves.toBeNull();
    expect(mocks.findAgent).not.toHaveBeenCalled();
  });
});
