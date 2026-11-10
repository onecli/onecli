// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ── Settings > Workspace > Settings ─────────────────────────────────────────
//
// A server component. Two things are pinned: a viewer who can't manage the
// workspace gets nothing (the backstop behind the modal hiding the page), and
// the three reads that only need the workspace (manage authority, the org's
// workspace count, the plan) start together rather than one after another.

const state = vi.hoisted(() => ({
  canManage: true,
  workspaceCount: 2,
  started: [] as string[],
  release: (): void => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => ({ id: "ext-1", email: "a@b.c" }),
}));

// Each read records that it started, then waits on one shared gate, so a
// sequential chain would stall after the first and fail the "all started"
// check below.
const gate = () => {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  state.release = open;
  return p;
};
let barrier: Promise<void>;

vi.mock("@onecli/db", () => ({
  db: {
    user: { findUnique: async () => ({ id: "u1" }) },
    workspace: {
      findFirst: async () => ({
        id: "w1",
        name: "Main",
        timezone: "UTC",
        organizationId: "o1",
      }),
      count: async () => {
        state.started.push("count");
        await barrier;
        return state.workspaceCount;
      },
    },
  },
}));

vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  canManageWorkspace: async () => {
    state.started.push("canManage");
    await barrier;
    return state.canManage;
  },
}));

vi.mock("@onecli/api/ee/services/quota-service", () => ({
  getWorkspaceQuota: async () => {
    state.started.push("quota");
    await barrier;
    return { plan: "pro" };
  },
}));

vi.mock("@dashboard/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("./_components/rename-workspace-form", () => ({
  RenameWorkspaceForm: () => <div>rename</div>,
}));
vi.mock("./_components/workspace-timezone-card", () => ({
  WorkspaceTimezoneCard: () => <div>timezone</div>,
}));
vi.mock("@/ee/workspaces/_components/workspace-access-card", () => ({
  WorkspaceAccessCard: ({ plan }: { plan: string }) => <div>access:{plan}</div>,
}));
vi.mock("./_components/delete-workspace-button", () => ({
  DeleteWorkspaceButton: ({
    isLastWorkspace,
  }: {
    isLastWorkspace: boolean;
  }) => <div>delete:{isLastWorkspace ? "last" : "many"}</div>,
}));

import WorkspaceSettingsPage from "./settings-page";

const renderPage = async () => {
  const pending = WorkspaceSettingsPage({ workspaceId: "w1" });
  // Let the session, user and workspace lookups resolve, then every read
  // that can start without waiting on another has started.
  await new Promise((r) => setTimeout(r, 0));
  const startedBeforeRelease = [...state.started];
  state.release();
  const ui = await pending;
  if (ui) render(ui);
  return { ui, startedBeforeRelease };
};

beforeEach(() => {
  state.canManage = true;
  state.workspaceCount = 2;
  state.started = [];
  barrier = gate();
});

afterEach(cleanup);

describe("WorkspaceSettingsPage", () => {
  it("renders the manage surface for a viewer who can manage", async () => {
    const { ui } = await renderPage();
    expect(ui).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("access:pro")).toBeTruthy();
    expect(screen.getByText("delete:many")).toBeTruthy();
  });

  it("renders nothing for a viewer who can't manage the workspace", async () => {
    state.canManage = false;
    const { ui } = await renderPage();
    expect(ui).toBeNull();
    expect(screen.queryByText("rename")).toBeNull();
    expect(screen.queryByText(/^delete:/)).toBeNull();
  });

  it("marks the org's only workspace as the last one", async () => {
    state.workspaceCount = 1;
    await renderPage();
    expect(screen.getByText("delete:last")).toBeTruthy();
  });

  it("starts the three workspace reads together, not one after another", async () => {
    const { startedBeforeRelease } = await renderPage();
    expect([...startedBeforeRelease].sort()).toEqual(
      ["canManage", "count", "quota"].sort(),
    );
  });
});
