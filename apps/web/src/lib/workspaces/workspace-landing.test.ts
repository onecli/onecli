import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace front door. The law pinned here: access is proven BEFORE the
 * agent read, so a caller who cannot open the workspace is redirected away
 * and never handed a redirect that names one of its agents.
 */

const state = vi.hoisted(() => ({
  access: "ok" as "ok" | "denied",
  firstAgent: null as { id: string; kind: string } | null,
  findFirst: vi.fn(),
}));

vi.mock("@/lib/workspaces/workspace-access", () => ({
  requireAccessibleWorkspace: async (workspaceId: string) => {
    if (state.access === "denied") throw new Error("NEXT_REDIRECT:/org");
    return { id: workspaceId, name: "WS", organizationId: "org-1" };
  },
}));

vi.mock("@onecli/db", () => ({
  db: {
    agent: {
      findFirst: (args: unknown) => {
        state.findFirst(args);
        return Promise.resolve(state.firstAgent);
      },
    },
  },
}));

const { resolveWorkspaceLanding } = await import("./workspace-landing");

beforeEach(() => {
  state.access = "ok";
  state.firstAgent = null;
  state.findFirst.mockReset();
});

describe("resolveWorkspaceLanding", () => {
  it("opens the workspace's oldest agent on its first section", async () => {
    state.firstAgent = { id: "ag-old", kind: "hosted" };
    await expect(resolveWorkspaceLanding("ws1")).resolves.toBe(
      "/w/ws1/agents/ag-old/chat",
    );
    expect(state.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, kind: true },
    });
  });

  it("falls back to the agents page (agent creation) in an empty workspace", async () => {
    await expect(resolveWorkspaceLanding("ws1")).resolves.toBe("/w/ws1/agents");
  });

  it("never reads agents for a caller who cannot open the workspace", async () => {
    state.access = "denied";
    state.firstAgent = { id: "ag-secret", kind: "byo" };
    await expect(resolveWorkspaceLanding("ws1")).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(state.findFirst).not.toHaveBeenCalled();
  });
});
