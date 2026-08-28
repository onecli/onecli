import { describe, expect, it, vi } from "vitest";

// createWorkspace seeds the creator's WorkspaceAccess binding atomically with the
// workspace (step 13) — the write that makes the binding load-bearing once the
// access checks flip to bindings-only in 13b.

const state = vi.hoisted(() => ({
  createArgs: null as { data?: Record<string, unknown> } | null,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    workspace: {
      create: async (args: { data?: Record<string, unknown> }) => {
        state.createArgs = args;
        return { id: "p1", name: "My Workspace", slug: "my-workspace-abc123" };
      },
    },
  },
}));

import { createWorkspace } from "./workspace-service";
import { workspaceNameForOwner } from "../../services/organization-service";

describe("createWorkspace", () => {
  it("seeds the creator's WorkspaceAccess binding (owner) with the workspace", async () => {
    await createWorkspace("u1", "u1@acme.com", "My Workspace", "org-1");
    const data = state.createArgs?.data ?? {};
    expect(data.createdByUserId).toBe("u1");
    expect(data.accessBindings).toEqual({
      create: { userId: "u1", role: "owner" },
    });
  });

  it("accepts every workspaceNameForOwner output shape", async () => {
    // Pins the equivalence between the shared display-name rules the naming
    // helper validates against and this file's private validateWorkspaceName:
    // switchOrganizationAction feeds derived names straight into
    // createWorkspace, so a divergence would turn the org-switch auto-create
    // into a thrown error. Covers the name branch, the clamped-email branch,
    // and the terminal "Personal" guard.
    const derived = [
      workspaceNameForOwner("John Smith", "j@x.com"),
      workspaceNameForOwner(null, `${"a".repeat(60)}@example.com`),
      workspaceNameForOwner(null, "@-."),
    ];
    for (const name of derived) {
      await expect(
        createWorkspace("u1", "u1@acme.com", name, "org-1"),
      ).resolves.toBeTruthy();
    }
  });
});
