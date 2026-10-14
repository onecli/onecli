import { beforeEach, describe, expect, it, vi } from "vitest";

// updateOrgWorkspace owns one setting that is baked into every hosted agent's
// container environment: the workspace timezone. A change must reach the
// running sandboxes (respawn), and a no-op must not, since the settings form
// re-sends the stored value and a respawn costs every agent its container.

const state = vi.hoisted(() => ({
  stored: { id: "ws-1", timezone: null as string | null },
  updateArgs: null as { data?: Record<string, unknown> } | null,
  respawned: [] as string[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    workspace: {
      // The slug-conflict probe carries NOT (never a conflict here); the
      // workspace lookup is honoured only for the org that owns it.
      findFirst: async ({
        where,
      }: {
        where: { id?: string; organizationId?: string; NOT?: unknown };
      }) =>
        where.NOT || where.organizationId !== "org-1" ? null : state.stored,
      update: async (args: { data?: Record<string, unknown> }) => {
        state.updateArgs = args;
        return { id: "ws-1", ...args.data };
      },
    },
  },
}));

vi.mock("../../services/sandbox-service", () => ({
  requestWorkspaceSandboxRespawn: async (workspaceId: string) => {
    state.respawned.push(workspaceId);
  },
}));

import { updateOrgWorkspace } from "./workspace-service";

beforeEach(() => {
  state.stored = { id: "ws-1", timezone: null };
  state.updateArgs = null;
  state.respawned = [];
});

describe("updateOrgWorkspace timezone", () => {
  it("stores a new zone and respawns the workspace's live sandboxes", async () => {
    await updateOrgWorkspace("org-1", "ws-1", { timezone: "Asia/Jerusalem" });
    expect(state.updateArgs?.data).toEqual({ timezone: "Asia/Jerusalem" });
    expect(state.respawned).toEqual(["ws-1"]);
  });

  it("clears the zone back to the platform default, which is a change too", async () => {
    state.stored.timezone = "Asia/Jerusalem";
    await updateOrgWorkspace("org-1", "ws-1", { timezone: null });
    expect(state.updateArgs?.data).toEqual({ timezone: null });
    expect(state.respawned).toEqual(["ws-1"]);
  });

  it("does NOT respawn when the zone re-sent is the one already stored", async () => {
    state.stored.timezone = "Asia/Jerusalem";
    await updateOrgWorkspace("org-1", "ws-1", {
      name: "Renamed",
      timezone: "Asia/Jerusalem",
    });
    expect(state.updateArgs?.data).toEqual({
      name: "Renamed",
      slug: "renamed",
    });
    expect(state.respawned).toEqual([]);
  });

  it("leaves the zone alone when the update does not mention it", async () => {
    state.stored.timezone = "Asia/Jerusalem";
    await updateOrgWorkspace("org-1", "ws-1", { name: "Renamed" });
    expect(state.updateArgs?.data).not.toHaveProperty("timezone");
    expect(state.respawned).toEqual([]);
  });

  it("fences the lookup by organization", async () => {
    await expect(
      updateOrgWorkspace("org-other", "ws-1", { timezone: "UTC" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.respawned).toEqual([]);
  });
});
